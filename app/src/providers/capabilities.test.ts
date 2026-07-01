import { describe, it, expect } from 'vitest';
import { supportsTemperature, isChatModel, supportsTools, maxTokensField } from './capabilities';

describe('supportsTemperature', () => {
  it('should omit temperature for the GPT-5 family and o-series reasoning models', () => {
    expect(supportsTemperature('openai', 'o3')).toBe(false);
    expect(supportsTemperature('openai', 'o4-mini')).toBe(false);
    expect(supportsTemperature('openai', 'gpt-5-mini')).toBe(false);
    expect(supportsTemperature('openai', 'gpt-5.5')).toBe(false);
  });
  it('should send temperature for gpt-4 / gpt-3.5 family models', () => {
    expect(supportsTemperature('openai', 'gpt-4o')).toBe(true);
    expect(supportsTemperature('openai', 'gpt-4.1')).toBe(true);
    expect(supportsTemperature('openai', 'gpt-3.5-turbo')).toBe(true);
  });
  it('should send temperature for non-OpenAI providers', () => {
    expect(supportsTemperature('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(supportsTemperature('google', 'gemini-3.5-pro')).toBe(true);
  });
  it('should fail open and send temperature for unknown / newer OpenAI ids', () => {
    expect(supportsTemperature('openai', 'gpt-6')).toBe(true);
    expect(supportsTemperature('openai', 'gpt-4.5-turbo-next')).toBe(true);
  });
  it('should send temperature for fine-tune ids', () => {
    expect(supportsTemperature('openai', 'ft:gpt-4o-2024:my-org::abc123')).toBe(true);
  });
});

describe('maxTokensField', () => {
  it('should use max_completion_tokens for the o-series and gpt-5 reasoning families', () => {
    expect(maxTokensField('openai', 'o3')).toBe('max_completion_tokens');
    expect(maxTokensField('openai', 'o4-mini')).toBe('max_completion_tokens');
    expect(maxTokensField('openai', 'gpt-5-mini')).toBe('max_completion_tokens');
    expect(maxTokensField('openai', 'gpt-5.5')).toBe('max_completion_tokens');
  });
  it('should use max_tokens for gpt-4 / gpt-3.5 family models', () => {
    expect(maxTokensField('openai', 'gpt-4o')).toBe('max_tokens');
    expect(maxTokensField('openai', 'gpt-3.5-turbo')).toBe('max_tokens');
  });
  it('should fail open to max_tokens for unknown / fine-tune OpenAI ids', () => {
    expect(maxTokensField('openai', 'gpt-6')).toBe('max_tokens');
    expect(maxTokensField('openai', 'ft:gpt-4o-2024:my-org::abc123')).toBe('max_tokens');
  });
  it('should use max_tokens for non-OpenAI providers', () => {
    expect(maxTokensField('anthropic', 'claude-sonnet-4-6')).toBe('max_tokens');
    expect(maxTokensField('google', 'gemini-3.5-pro')).toBe('max_tokens');
  });
});

describe('isChatModel', () => {
  it('should drop non-chat OpenAI models', () => {
    expect(isChatModel('openai', 'text-embedding-3-large')).toBe(false);
    expect(isChatModel('openai', 'whisper-1')).toBe(false);
    expect(isChatModel('openai', 'dall-e-3')).toBe(false);
    expect(isChatModel('openai', 'gpt-4o-realtime')).toBe(false);
  });
  it('should keep chat models', () => {
    expect(isChatModel('openai', 'gpt-5.5')).toBe(true);
    expect(isChatModel('openai', 'o3')).toBe(true);
  });
  it('should keep all models for other providers', () => {
    expect(isChatModel('google', 'gemini-3.5-flash')).toBe(true);
  });
});

describe('supportsTools', () => {
  it('should report tool support for OpenAI chat / reasoning families', () => {
    expect(supportsTools('openai', 'gpt-4o')).toBe(true);
    expect(supportsTools('openai', 'gpt-4.1')).toBe(true);
    expect(supportsTools('openai', 'gpt-4-turbo')).toBe(true);
    expect(supportsTools('openai', 'o3')).toBe(true);
    expect(supportsTools('openai', 'o4-mini')).toBe(true);
    expect(supportsTools('openai', 'gpt-5.1')).toBe(true);
    expect(supportsTools('openai', 'gpt-3.5-turbo')).toBe(true);
  });
  it('should deny tools for non-tool OpenAI models', () => {
    expect(supportsTools('openai', 'gpt-3.5-turbo-instruct')).toBe(true); // turbo variants do
    expect(supportsTools('openai', 'gpt-3.5')).toBe(false); // legacy base
    expect(supportsTools('openai', 'text-embedding-3-large')).toBe(false);
    expect(supportsTools('openai', 'whisper-1')).toBe(false);
  });
  it('should report tool support for Anthropic claude-3+ / claude-4', () => {
    expect(supportsTools('anthropic', 'claude-3-opus')).toBe(true);
    expect(supportsTools('anthropic', 'claude-3-5-sonnet')).toBe(true);
    expect(supportsTools('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(supportsTools('anthropic', 'claude-opus-4-1')).toBe(true);
  });
  it('should deny tools for legacy Anthropic models', () => {
    expect(supportsTools('anthropic', 'claude-2.1')).toBe(false);
    expect(supportsTools('anthropic', 'claude-instant-1.2')).toBe(false);
  });
  it('should report tool support for Gemini 1.5 / 2.x+ and deny 1.0', () => {
    expect(supportsTools('google', 'gemini-1.5-pro')).toBe(true);
    expect(supportsTools('google', 'gemini-2.5-pro')).toBe(true);
    expect(supportsTools('google', 'gemini-2.0-flash')).toBe(true);
    expect(supportsTools('google', 'gemini-3.5-pro')).toBe(true);
    expect(supportsTools('google', 'gemini-1.0-pro')).toBe(false);
    expect(supportsTools('google', 'gemini-pro-vision')).toBe(false);
  });
  it('should fail open and report tool support for unknown / newer ids', () => {
    expect(supportsTools('openai', 'gpt-6')).toBe(true);
    expect(supportsTools('anthropic', 'claude-5-sonnet')).toBe(true);
    expect(supportsTools('google', 'gemini-3-pro')).toBe(true);
    expect(supportsTools('openai', 'my-org/llama-tool')).toBe(true);
  });
  it('should report tool support for fine-tune ids', () => {
    expect(supportsTools('openai', 'ft:gpt-4o-2024:my-org::abc123')).toBe(true);
  });
});
