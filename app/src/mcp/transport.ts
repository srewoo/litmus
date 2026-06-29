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
import type { FetchLike, FetchResponse } from '../providers/types';
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

export interface TransportDeps {
  readonly fetchImpl?: FetchLike;
  readonly signal?: AbortSignal;
  /** Protocol version to advertise on the `MCP-Protocol-Version` header after init. */
  readonly protocolVersion?: string;
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

  constructor(
    private readonly config: McpServerConfig,
    private readonly deps: TransportDeps,
  ) {
    this.fetchImpl = deps.fetchImpl ?? defaultFetch();
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
    const res = await this.post(JSON.stringify(req));
    this.captureSession(res);
    const ctype = res.headers?.get('content-type') ?? '';
    const msg = ctype.includes('text/event-stream')
      ? await this.readFromStream(res, req.id)
      : await this.readFromJson(res);
    if (!msg) throw new McpTransportError(res.status, `no JSON-RPC response for id ${req.id}`);
    return msg;
  }

  async notify(n: JsonRpcNotification): Promise<void> {
    const res = await this.post(JSON.stringify(n));
    this.captureSession(res);
    // Notifications get 202/204 and no body; drain any text to release the socket.
    await res.text().catch(() => '');
  }

  private async post(body: string): Promise<FetchResponse> {
    const res = await this.fetchImpl(this.config.url, {
      method: 'POST',
      headers: this.headers(),
      body,
      ...(this.deps.signal ? { signal: this.deps.signal } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new McpTransportError(res.status, detail);
    }
    return res;
  }

  private async readFromJson(res: FetchResponse): Promise<JsonRpcResponse | null> {
    const text = await res.text();
    const parsed = safeParse(text);
    return isJsonRpcResponse(parsed) ? parsed : null;
  }

  private async readFromStream(res: FetchResponse, id: number): Promise<JsonRpcResponse | null> {
    if (!res.body) return null;
    for await (const payload of iterateSSE(res.body)) {
      const parsed = safeParse(payload);
      if (isJsonRpcResponse(parsed) && parsed.id === id) return parsed;
    }
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
