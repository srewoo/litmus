import { describe, it, expect } from 'vitest';
import { parseSettings, TargetModelSchema, OpenAIUsageSchema } from './schema';

describe('parseSettings', () => {
  it('should apply defaults to an empty object', () => {
    const s = parseSettings({});
    expect(s).toMatchObject({ keys: {}, passThreshold: 6, spendCapUsd: 0.5 });
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

describe('OpenAIUsageSchema', () => {
  it('should parse a partial usage block', () => {
    expect(OpenAIUsageSchema.parse({ total_tokens: 42 }).total_tokens).toBe(42);
  });
  it('should reject negative token counts', () => {
    expect(OpenAIUsageSchema.safeParse({ total_tokens: -1 }).success).toBe(false);
  });
});
