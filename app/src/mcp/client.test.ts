import { describe, it, expect } from 'vitest';
import { McpClient } from './client';
import type { McpTransport } from './transport';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './jsonrpc';

/** A scripted fake transport: map of method → result, recording every message. */
class FakeTransport implements McpTransport {
  sessionId: string | undefined;
  readonly requests: JsonRpcRequest[] = [];
  readonly notifications: JsonRpcNotification[] = [];
  closeCalls = 0;
  constructor(
    private readonly results: Record<string, unknown>,
    sessionId?: string,
  ) {
    this.sessionId = sessionId;
  }
  request(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.requests.push(req);
    if (!(req.method in this.results)) {
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no method' } });
    }
    return Promise.resolve({ jsonrpc: '2.0', id: req.id, result: this.results[req.method] });
  }
  notify(n: JsonRpcNotification): Promise<void> {
    this.notifications.push(n);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

const HANDSHAKE = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {}, resources: {} },
  serverInfo: { name: 'demo', version: '1.0.0' },
};

describe('McpClient.connect', () => {
  it('runs the handshake then sends notifications/initialized', async () => {
    const t = new FakeTransport({ initialize: HANDSHAKE }, 'sess-9');
    const client = new McpClient(t);
    const hs = await client.connect();
    expect(hs.capabilities).toEqual({ tools: true, resources: true, prompts: false });
    expect(hs.sessionId).toBe('sess-9');
    expect(t.requests[0]?.method).toBe('initialize');
    expect(t.notifications[0]?.method).toBe('notifications/initialized');
  });

  it('is idempotent — a second connect does not re-handshake', async () => {
    const t = new FakeTransport({ initialize: HANDSHAKE });
    const client = new McpClient(t);
    await client.connect();
    await client.connect();
    expect(t.requests.filter((r) => r.method === 'initialize')).toHaveLength(1);
  });

  it('throws if capabilities is read before connect', () => {
    const client = new McpClient(new FakeTransport({}));
    expect(() => client.capabilities).toThrow();
  });

  it('does not cache the handshake when notifications/initialized fails', async () => {
    // A transport whose notify rejects: the handshake must NOT be cached, so a
    // later connect() retries rather than returning an uninitialized success.
    let notifyCalls = 0;
    class FailingNotifyTransport extends FakeTransport {
      override notify(n: JsonRpcNotification): Promise<void> {
        notifyCalls += 1;
        if (notifyCalls === 1) return Promise.reject(new Error('notify boom'));
        return super.notify(n);
      }
    }
    const t = new FailingNotifyTransport({ initialize: HANDSHAKE });
    const client = new McpClient(t);
    await expect(client.connect()).rejects.toThrow(/notify boom/);
    expect(() => client.capabilities).toThrow(); // not cached
    // A retry now succeeds and re-runs the handshake.
    const hs = await client.connect();
    expect(hs.capabilities).toEqual({ tools: true, resources: true, prompts: false });
    expect(t.requests.filter((r) => r.method === 'initialize')).toHaveLength(2);
  });
});

describe('McpClient list/call methods', () => {
  it('lists tools', async () => {
    const t = new FakeTransport({
      initialize: HANDSHAKE,
      'tools/list': { tools: [{ name: 'get_weather', inputSchema: { type: 'object' } }] },
    });
    const client = new McpClient(t);
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'get_weather', inputSchema: { type: 'object' } }]);
  });

  it('calls a tool and normalizes the result', async () => {
    const t = new FakeTransport({
      initialize: HANDSHAKE,
      'tools/call': { content: [{ type: 'text', text: '18C' }], isError: false },
    });
    const client = new McpClient(t);
    await client.connect();
    const res = await client.callTool('get_weather', { city: 'Paris' });
    expect(res).toEqual({ isError: false, text: '18C', content: [{ type: 'text', text: '18C' }] });
    const call = t.requests.find((r) => r.method === 'tools/call');
    expect(call?.params).toEqual({ name: 'get_weather', arguments: { city: 'Paris' } });
  });

  it('surfaces a JSON-RPC error as a thrown JsonRpcCallError', async () => {
    const t = new FakeTransport({ initialize: HANDSHAKE }); // no prompts/list → error
    const client = new McpClient(t);
    await client.connect();
    await expect(client.listPrompts()).rejects.toThrow(/no method/);
  });
});

describe('McpClient.close', () => {
  it('tears down the transport session and clears the cached handshake', async () => {
    const t = new FakeTransport({ initialize: HANDSHAKE }, 'sess-9');
    const client = new McpClient(t);
    await client.connect();
    await client.close();
    expect(t.closeCalls).toBe(1); // transport teardown issued
    expect(() => client.capabilities).toThrow(); // handshake cleared → re-handshake required
  });
});
