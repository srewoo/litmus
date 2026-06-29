import { describe, it, expect } from 'vitest';
import { parseSettings, TargetModelSchema, OpenAIUsageSchema, McpServerConfigSchema, ScenarioSchema } from './schema';

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
