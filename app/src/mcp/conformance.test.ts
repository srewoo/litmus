import { describe, it, expect } from 'vitest';
import { checkToolSchema, runConformance } from './conformance';
import { McpClient } from './client';
import type { McpTransport } from './transport';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './jsonrpc';

class FakeTransport implements McpTransport {
  sessionId: string | undefined;
  constructor(private readonly results: Record<string, unknown>) {}
  request(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!(req.method in this.results)) {
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no method' } });
    }
    return Promise.resolve({ jsonrpc: '2.0', id: req.id, result: this.results[req.method] });
  }
  notify(_n: JsonRpcNotification): Promise<void> {
    return Promise.resolve();
  }
}

describe('checkToolSchema', () => {
  it('passes a well-formed schema with a description', () => {
    const f = checkToolSchema({ name: 'get', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } });
    expect(f).toEqual([{ level: 'pass', check: 'tool:get', detail: 'schema looks well-formed' }]);
  });
  it('warns on a non-object type', () => {
    const f = checkToolSchema({ name: 'g', description: 'd', inputSchema: { type: 'string' } });
    expect(f.some((x) => x.level === 'warn' && /expected "object"/.test(x.detail))).toBe(true);
  });
  it('warns when a required key is absent from properties', () => {
    const f = checkToolSchema({ name: 'g', description: 'd', inputSchema: { type: 'object', properties: {}, required: ['city'] } });
    expect(f.some((x) => /required "city"/.test(x.detail))).toBe(true);
  });
  it('warns when the tool has no description', () => {
    const f = checkToolSchema({ name: 'g', inputSchema: { type: 'object' } });
    expect(f.some((x) => /no description/.test(x.detail))).toBe(true);
  });
});

const HANDSHAKE = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'demo', version: '1.0.0' },
};

describe('runConformance', () => {
  it('reports a clean server as ok with capability counts', async () => {
    const client = new McpClient(
      new FakeTransport({
        initialize: HANDSHAKE,
        'tools/list': { tools: [{ name: 'get', description: 'd', inputSchema: { type: 'object' } }] },
        'resources/list': { resources: [{ uri: 'file://a' }] },
        'prompts/list': { prompts: [] },
      }),
    );
    const report = await runConformance(client);
    expect(report.ok).toBe(true);
    expect(report.toolCount).toBe(1);
    expect(report.resourceCount).toBe(1);
    expect(report.findings.some((f) => f.check === 'handshake' && f.level === 'pass')).toBe(true);
  });

  it('fails when a handshake-advertised capability cannot be listed', async () => {
    const client = new McpClient(
      new FakeTransport({ initialize: HANDSHAKE, 'tools/list': { tools: [] }, 'resources/list': { resources: [] } }),
    ); // prompts advertised but prompts/list missing → error → fail
    const report = await runConformance(client);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.level === 'fail' && f.check === 'prompts')).toBe(true);
  });

  it('records a fail finding when the handshake itself fails', async () => {
    const client = new McpClient(new FakeTransport({})); // initialize → error
    const report = await runConformance(client);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.check).toBe('handshake');
    expect(report.findings[0]?.level).toBe('fail');
  });
});
