/**
 * MCP client: the strict init handshake (initialize → capabilities → the
 * `notifications/initialized` notification) plus the list/call methods litmus
 * needs. Transport-agnostic — it is constructed with an `McpTransport` so the
 * client is unit-testable against a fake transport with no network.
 */
import {
  createIdSource,
  makeNotification,
  makeRequest,
  unwrap,
} from './jsonrpc';
import type { McpTransport } from './transport';
import { createTransport } from './transport';
import {
  toCallResult,
  toHandshake,
  toPrompts,
  toResources,
  toToolDescriptors,
} from './schema';
import type {
  McpCallResult,
  McpHandshake,
  McpPrompt,
  McpResource,
  McpServerConfig,
  McpToolDescriptor,
} from './types';

/** Latest protocol version litmus requests; servers negotiate down if needed. */
export const CLIENT_PROTOCOL_VERSION = '2025-06-18';

const CLIENT_INFO = { name: 'litmus', version: '1.1.0' };

export class McpClient {
  private readonly nextId = createIdSource();
  private handshake: McpHandshake | undefined;

  constructor(private readonly transport: McpTransport) {}

  /** Run the initialize handshake. Idempotent — returns the cached result if already connected. */
  async connect(): Promise<McpHandshake> {
    if (this.handshake) return this.handshake;
    const res = await this.transport.request(
      makeRequest(this.nextId(), 'initialize', {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }),
    );
    const result = unwrap('initialize', res);
    this.handshake = toHandshake(result, this.transport.sessionId);
    await this.transport.notify(makeNotification('notifications/initialized'));
    return this.handshake;
  }

  /** The negotiated handshake; throws if `connect()` has not run. */
  get capabilities(): McpHandshake {
    if (!this.handshake) throw new Error('McpClient: connect() must be called before use');
    return this.handshake;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return toToolDescriptors(await this.call('tools/list'));
  }

  async listResources(): Promise<McpResource[]> {
    return toResources(await this.call('resources/list'));
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return toPrompts(await this.call('prompts/list'));
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    return toCallResult(await this.call('tools/call', { name, arguments: args ?? {} }));
  }

  private async call(method: string, params?: unknown): Promise<unknown> {
    const res = await this.transport.request(makeRequest(this.nextId(), method, params));
    return unwrap(method, res);
  }
}

/** Build a client over a real Streamable-HTTP transport for a configured server. */
export function connectMcp(
  config: McpServerConfig,
  deps: { fetchImpl?: import('../providers/types').FetchLike; signal?: AbortSignal } = {},
): McpClient {
  const transport = createTransport(config, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    protocolVersion: CLIENT_PROTOCOL_VERSION,
  });
  return new McpClient(transport);
}
