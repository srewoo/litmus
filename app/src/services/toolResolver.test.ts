import { describe, it, expect } from 'vitest';
import { mcpResolver, mockResolver } from './toolResolver';
import { runAgent } from './agentRun';
import { McpClient } from '../mcp/client';
import type { McpTransport } from '../mcp/transport';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from '../mcp/jsonrpc';
import type { McpToolDescriptor } from '../mcp/types';
import type { Scenario, ToolCall } from '../shared/types';

class FakeTransport implements McpTransport {
  sessionId: string | undefined;
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  constructor(private readonly handler: (method: string, params?: unknown) => unknown) {}
  request(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.calls.push({ method: req.method, params: req.params });
    try {
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, result: this.handler(req.method, req.params) });
    } catch (e) {
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, error: { code: -1, message: (e as Error).message } });
    }
  }
  notify(_n: JsonRpcNotification): Promise<void> {
    return Promise.resolve();
  }
}

const TOOLS: McpToolDescriptor[] = [
  { name: 'get_weather', description: 'w', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
];

const HANDSHAKE = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'd', version: '1' } };

async function connectedClient(handler: (m: string, p?: unknown) => unknown): Promise<McpClient> {
  const client = new McpClient(new FakeTransport((m, p) => (m === 'initialize' ? HANDSHAKE : handler(m, p))));
  await client.connect();
  return client;
}

const call = (name: string, args: unknown): ToolCall => ({ name, arguments: args });

describe('mcpResolver', () => {
  it('dispatches a real tools/call and maps success to a value result', async () => {
    const client = await connectedClient((m) =>
      m === 'tools/call' ? { content: [{ type: 'text', text: '18C' }], isError: false } : {},
    );
    const resolve = mcpResolver(client, TOOLS);
    const rec = await resolve(call('get_weather', { city: 'Paris' }), 0);
    expect(rec).toEqual({ name: 'get_weather', result: { value: '18C' }, known: true, argsValid: true });
  });

  it('maps an isError tool result to an error result', async () => {
    const client = await connectedClient(() => ({ content: [{ type: 'text', text: 'nope' }], isError: true }));
    const rec = await mcpResolver(client, TOOLS)(call('get_weather', { city: 'X' }), 0);
    expect(rec.result).toEqual({ error: 'nope' });
  });

  it('flags an unknown tool without calling the server', async () => {
    let called = false;
    const client = await connectedClient((m) => {
      if (m === 'tools/call') called = true;
      return {};
    });
    const rec = await mcpResolver(client, TOOLS)(call('missing', {}), 0);
    expect(rec.known).toBe(false);
    expect(called).toBe(false);
  });

  it('marks invalid arguments against the discovered schema', async () => {
    const client = await connectedClient(() => ({ content: [], isError: false }));
    const rec = await mcpResolver(client, TOOLS)(call('get_weather', { city: 123 }), 0);
    expect(rec.argsValid).toBe(false); // city should be a string
  });

  it('turns a transport/RPC failure into an error result (loop keeps going)', async () => {
    const client = await connectedClient((m) => {
      if (m === 'tools/call') throw new Error('boom');
      return {};
    });
    const rec = await mcpResolver(client, TOOLS)(call('get_weather', { city: 'P' }), 0);
    expect('error' in rec.result && rec.result.error).toMatch(/boom/);
  });
});

describe('runAgent with an MCP resolver', () => {
  it('drives the loop against the live resolver and reaches the goal', async () => {
    const client = await connectedClient((m) =>
      m === 'tools/call' ? { content: [{ type: 'text', text: 'sunny 18C' }], isError: false } : {},
    );
    const scenario: Scenario = { goal: 'weather in Paris', tools: [], maxSteps: 3, successContains: ['18C'], mcpServerId: 's1' };
    // model: first turn calls the tool, second turn answers with the tool output.
    let turn = 0;
    const step = async () => {
      turn += 1;
      return turn === 1
        ? { text: 'checking', toolCalls: [call('get_weather', { city: 'Paris' })] }
        : { text: 'It is sunny 18C', toolCalls: [] };
    };
    const traj = await runAgent('SYS', scenario, step, undefined, mcpResolver(client, TOOLS));
    expect(traj.stopReason).toBe('final');
    expect(traj.finalText).toContain('18C');
    expect(traj.steps[0]?.toolResults[0]?.known).toBe(true);
  });
});

describe('mockResolver (re-exported default)', () => {
  it('still replays scripted mock responses', async () => {
    const scenario: Scenario = {
      goal: 'g',
      tools: [{ name: 't', parameters: { type: 'object' }, results: [{ value: 42 }] }],
      maxSteps: 2,
    };
    const rec = await mockResolver(scenario)(call('t', {}), 0);
    expect(rec).toEqual({ name: 't', result: { value: 42 }, known: true, argsValid: true });
  });
});
