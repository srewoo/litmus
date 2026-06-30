/**
 * MCP Streamable-HTTP transport (spec 2025-03-26+). A request is one HTTP POST of
 * a JSON-RPC message; the server replies either with `application/json` (a single
 * response) or `text/event-stream` (SSE frames, each a JSON-RPC message) — we read
 * frames until the one matching our request id arrives. Built on the injectable
 * `FetchLike` so it is unit-testable without network. Session id (when the server
 * issues one on initialize) is captured and echoed on every later request.
 *
 * Note: the legacy dual-endpoint SSE transport (separate GET stream + POST) is out
 * of scope for v1 (ADR 0003); `transport: 'sse'` here only sets the Accept header.
 */
import type { FetchInit, FetchLike, FetchResponse } from '../providers/types';
import { defaultFetch } from '../providers/types';
import { iterateSSE } from '../providers/sse';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './jsonrpc';
import { isJsonRpcResponse } from './jsonrpc';
import type { McpServerConfig } from './types';

export interface McpTransport {
  request(req: JsonRpcRequest): Promise<JsonRpcResponse>;
  notify(n: JsonRpcNotification): Promise<void>;
  /** Session id captured from a server response, if any. */
  readonly sessionId: string | undefined;
}

/** Default per-request timeout; a held-open SSE stream rejects instead of hanging forever. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface TransportDeps {
  readonly fetchImpl?: FetchLike;
  readonly signal?: AbortSignal;
  /** Protocol version to advertise on the `MCP-Protocol-Version` header after init. */
  readonly protocolVersion?: string;
  /** Per-request timeout in ms; defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Raised when the transport itself fails (HTTP non-OK, no parsable response). */
export class McpTransportError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`MCP transport HTTP ${status}: ${detail.slice(0, 200)}`);
    this.name = 'McpTransportError';
  }
}

class HttpTransport implements McpTransport {
  sessionId: string | undefined;
  private readonly fetchImpl: FetchLike;

  private readonly timeoutMs: number;

  constructor(
    private readonly config: McpServerConfig,
    private readonly deps: TransportDeps,
  ) {
    this.fetchImpl = deps.fetchImpl ?? defaultFetch();
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    const accept = this.config.transport === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream';
    const h: Record<string, string> = { 'content-type': 'application/json', accept };
    if (this.config.authHeader) h['authorization'] = this.config.authHeader;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.deps.protocolVersion) h['mcp-protocol-version'] = this.deps.protocolVersion;
    return h;
  }

  private captureSession(res: FetchResponse): void {
    const id = res.headers?.get('mcp-session-id');
    if (id) this.sessionId = id;
  }

  async request(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    // One timeout governs the whole request — the POST AND the (possibly held-open)
    // SSE read — combined with any injected signal, so a slow/hung server rejects
    // loudly instead of hanging forever.
    const { signal, done } = this.deadline();
    try {
      const res = await this.post(JSON.stringify(req), signal);
      this.captureSession(res);
      const ctype = res.headers?.get('content-type') ?? '';
      const msg = ctype.includes('text/event-stream')
        ? await this.readFromStream(res, req.id, signal)
        : await this.readFromJson(res, req.id);
      if (!msg) throw new McpTransportError(res.status, `no JSON-RPC response for id ${req.id}`);
      return msg;
    } finally {
      done();
    }
  }

  async notify(n: JsonRpcNotification): Promise<void> {
    const { signal, done } = this.deadline();
    try {
      const res = await this.post(JSON.stringify(n), signal);
      this.captureSession(res);
      // Notifications get 202/204 and no body; drain any text to release the socket.
      await res.text().catch(() => '');
    } finally {
      done();
    }
  }

  /**
   * Build a combined abort signal that fires when the injected signal aborts OR
   * the timeout elapses, plus a `done()` that clears the timer. Always call
   * `done()` (in a finally) so a successful request leaves no dangling timer.
   */
  private deadline(): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const injected = this.deps.signal;
    if (injected) {
      if (injected.aborted) controller.abort();
      else injected.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(new McpTransportError(0, `request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      injected?.removeEventListener('abort', onAbort);
    };
    return { signal: controller.signal, done };
  }

  private throwIfTimedOut(signal: AbortSignal): never {
    const reason = signal.reason;
    if (reason instanceof McpTransportError) throw reason;
    throw new McpTransportError(0, `request aborted after ${this.timeoutMs}ms`);
  }

  private async post(body: string, signal: AbortSignal): Promise<FetchResponse> {
    if (signal.aborted) this.throwIfTimedOut(signal);
    let res: FetchResponse;
    try {
      res = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers: this.headers(),
        body,
        // Fail loudly on redirects: following them would replay the Authorization
        // header (a secret) to a new origin. The caller must reconfigure the URL.
        redirect: 'error',
        signal,
      } as FetchInit);
    } catch (err) {
      if (signal.aborted) this.throwIfTimedOut(signal);
      throw err;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new McpTransportError(res.status, detail);
    }
    return res;
  }

  private async readFromJson(res: FetchResponse, id: number): Promise<JsonRpcResponse | null> {
    const text = await res.text();
    const parsed = safeParse(text);
    // Match the id like the SSE path does — a body for a different id is not our response.
    return isJsonRpcResponse(parsed) && parsed.id === id ? parsed : null;
  }

  private async readFromStream(res: FetchResponse, id: number, signal: AbortSignal): Promise<JsonRpcResponse | null> {
    if (!res.body) return null;
    // Pass the deadline signal so iterateSSE cancels the underlying reader on
    // timeout/abort — a held-open stream then terminates instead of hanging.
    for await (const payload of iterateSSE(res.body, signal)) {
      const parsed = safeParse(payload);
      if (isJsonRpcResponse(parsed) && parsed.id === id) return parsed;
    }
    if (signal.aborted) this.throwIfTimedOut(signal);
    return null;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createTransport(config: McpServerConfig, deps: TransportDeps = {}): McpTransport {
  return new HttpTransport(config, deps);
}
