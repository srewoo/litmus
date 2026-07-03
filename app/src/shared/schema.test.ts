import { describe, it, expect } from 'vitest';
import { parseSettings, TargetModelSchema, OpenAIUsageSchema, McpServerConfigSchema, ScenarioSchema, isSafeHttpUrl, ToolExpectationSchema } from './schema';

describe('ToolExpectationSchema', () => {
  it('should reject an all-empty expectation that would auto-pass 10/10', () => {
    expect(ToolExpectationSchema.safeParse({}).success).toBe(false);
    // Empty collections are also vacuous and must be rejected.
    expect(ToolExpectationSchema.safeParse({ forbiddenTools: [], requiredArgs: {} }).success).toBe(false);
  });
  it('should accept an expectation asserting any single aspect', () => {
    expect(ToolExpectationSchema.safeParse({ expectedTool: 'get_weather' }).success).toBe(true);
    expect(ToolExpectationSchema.safeParse({ forbiddenTools: ['delete_account'] }).success).toBe(true);
    expect(ToolExpectationSchema.safeParse({ requiredArgs: { city: 'Paris' } }).success).toBe(true);
  });
});

describe('parseSettings', () => {
  it('should apply defaults to an empty object', () => {
    const s = parseSettings({});
    expect(s).toMatchObject({ keys: {}, passThreshold: 6, spendCapUsd: 0.5, samples: 1, judgeSamples: 1, concurrency: 1 });
    expect(s.mcpServers).toEqual([]); // ADR 0003: defaults to no servers
  });
  it('should parse configured MCP servers', () => {
    const s = parseSettings({ mcpServers: [{ id: 's1', name: 'demo', url: 'https://h/mcp' }] });
    expect(s.mcpServers[0]).toMatchObject({ id: 's1', url: 'https://h/mcp', transport: 'http' });
  });
  it('should apply defaults to undefined input', () => {
    expect(parseSettings(undefined).passThreshold).toBe(6);
  });
  it('should reject an out-of-range threshold', () => {
    expect(() => parseSettings({ passThreshold: 99 })).toThrow();
  });
  it('should accept a valid target and keys', () => {
    const s = parseSettings({ keys: { openai: 'sk-x' }, defaultTarget: { provider: 'openai', model: 'gpt-5.1' } });
    expect(s.defaultTarget?.model).toBe('gpt-5.1');
  });
});

describe('TargetModelSchema', () => {
  it('should reject an unknown provider', () => {
    expect(TargetModelSchema.safeParse({ provider: 'cohere', model: 'x' }).success).toBe(false);
  });
  it('should reject an empty model id', () => {
    expect(TargetModelSchema.safeParse({ provider: 'openai', model: '' }).success).toBe(false);
  });
});

describe('McpServerConfigSchema', () => {
  it('rejects a non-URL endpoint', () => {
    expect(McpServerConfigSchema.safeParse({ id: 's1', name: 'd', url: 'not-a-url' }).success).toBe(false);
  });
  it('rejects an unknown transport', () => {
    expect(McpServerConfigSchema.safeParse({ id: 's1', name: 'd', url: 'https://h', transport: 'stdio' }).success).toBe(false);
  });
});

describe('isSafeHttpUrl (SSRF guard)', () => {
  it('should accept ordinary http and https public hosts', () => {
    expect(isSafeHttpUrl('https://mcp.example.com/rpc')).toBe(true);
    expect(isSafeHttpUrl('http://mcp.example.com/rpc')).toBe(true);
    expect(isSafeHttpUrl('https://8.8.8.8/rpc')).toBe(true); // public IPv4 literal
    expect(isSafeHttpUrl('https://[2606:4700:4700::1111]/rpc')).toBe(true); // public IPv6
  });
  it('should reject non-http(s) schemes', () => {
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('ftp://example.com/x')).toBe(false);
  });
  it('should reject localhost and loopback', () => {
    expect(isSafeHttpUrl('http://localhost:3000/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://api.localhost/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://127.0.0.1/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://127.5.5.5/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://[::1]/rpc')).toBe(false);
  });
  it('should reject cloud-metadata and link-local addresses', () => {
    expect(isSafeHttpUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSafeHttpUrl('http://169.254.0.1/x')).toBe(false);
  });
  it('should reject RFC1918 private ranges', () => {
    expect(isSafeHttpUrl('http://10.0.0.5/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://172.16.0.1/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://172.31.255.255/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://192.168.1.1/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://0.0.0.0/rpc')).toBe(false);
  });
  it('should allow 172.x outside the 16-31 private band', () => {
    expect(isSafeHttpUrl('https://172.32.0.1/rpc')).toBe(true);
    expect(isSafeHttpUrl('https://172.15.0.1/rpc')).toBe(true);
  });
  it('should reject IPv4-mapped IPv6 loopback literals (dotted and hex forms)', () => {
    expect(isSafeHttpUrl('http://[::ffff:127.0.0.1]/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://[::ffff:7f00:1]/rpc')).toBe(false); // hex form of 127.0.0.1
    expect(isSafeHttpUrl('http://[::FFFF:127.0.0.1]/rpc')).toBe(false); // case-insensitive prefix
  });
  it('should reject IPv4-mapped IPv6 link-local/metadata and private literals', () => {
    expect(isSafeHttpUrl('http://[::ffff:169.254.169.254]/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://[::ffff:a9fe:a9fe]/rpc')).toBe(false); // hex form of 169.254.169.254
    expect(isSafeHttpUrl('http://[::ffff:10.0.0.5]/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://[::ffff:c0a8:101]/rpc')).toBe(false); // hex form of 192.168.1.1
  });
  it('should allow an IPv4-mapped PUBLIC address', () => {
    expect(isSafeHttpUrl('https://[::ffff:8.8.8.8]/rpc')).toBe(true);
    expect(isSafeHttpUrl('https://[::ffff:808:808]/rpc')).toBe(true); // hex form of 8.8.8.8
  });
  it('should reject IPv6 ULA and link-local literals', () => {
    expect(isSafeHttpUrl('http://[fc00::1]/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://[fd12:3456::1]/rpc')).toBe(false);
    expect(isSafeHttpUrl('http://[fe80::1]/rpc')).toBe(false);
  });
  it('should reject a malformed url', () => {
    expect(isSafeHttpUrl('not-a-url')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
  });
});

describe('McpServerConfigSchema SSRF refinement', () => {
  it('rejects a loopback url', () => {
    expect(McpServerConfigSchema.safeParse({ id: 's1', name: 'd', url: 'http://127.0.0.1/mcp' }).success).toBe(false);
  });
  it('rejects the cloud-metadata url', () => {
    expect(McpServerConfigSchema.safeParse({ id: 's1', name: 'd', url: 'http://169.254.169.254/' }).success).toBe(false);
  });
  it('rejects a file:// url', () => {
    expect(McpServerConfigSchema.safeParse({ id: 's1', name: 'd', url: 'file:///etc/passwd' }).success).toBe(false);
  });
  it('accepts a public https url', () => {
    expect(McpServerConfigSchema.safeParse({ id: 's1', name: 'd', url: 'https://mcp.example.com/rpc' }).success).toBe(true);
  });
});

describe('ScenarioSchema', () => {
  it('accepts an MCP-backed scenario with no mock tools', () => {
    const r = ScenarioSchema.safeParse({ goal: 'g', maxSteps: 3, mcpServerId: 's1' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tools).toEqual([]); // tools default to empty for MCP
  });
});

describe('OpenAIUsageSchema', () => {
  it('should parse a partial usage block', () => {
    expect(OpenAIUsageSchema.parse({ total_tokens: 42 }).total_tokens).toBe(42);
  });
  it('should reject negative token counts', () => {
    expect(OpenAIUsageSchema.safeParse({ total_tokens: -1 }).success).toBe(false);
  });
});
