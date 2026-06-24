import { describe, it, expect } from 'vitest';
import { getProvider, OpenAIProvider, AnthropicProvider, GoogleProvider } from './index';
import { defaultFetch, ProviderError } from './types';

describe('getProvider', () => {
  it('should resolve each provider id to the right adapter', () => {
    expect(getProvider('openai')).toBeInstanceOf(OpenAIProvider);
    expect(getProvider('anthropic')).toBeInstanceOf(AnthropicProvider);
    expect(getProvider('google')).toBeInstanceOf(GoogleProvider);
  });
  it('should expose a stable provider id on each adapter', () => {
    expect(getProvider('openai').id).toBe('openai');
    expect(getProvider('anthropic').id).toBe('anthropic');
    expect(getProvider('google').id).toBe('google');
  });
});

describe('defaultFetch', () => {
  it('should return a callable fetch', () => {
    expect(typeof defaultFetch()).toBe('function');
  });
});

describe('ProviderError', () => {
  it('should build a message with provider, status, and truncated detail', () => {
    const err = new ProviderError('openai', 500, 'boom');
    expect(err.name).toBe('ProviderError');
    expect(err.message).toContain('openai');
    expect(err.message).toContain('500');
    expect(err.status).toBe(500);
  });
});
