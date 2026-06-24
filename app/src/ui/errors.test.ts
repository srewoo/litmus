import { describe, it, expect } from 'vitest';
import { describeError } from './errors';
import { ProviderError } from '../providers/types';

describe('describeError', () => {
  it('should extract the provider error message and suggest changing the model on a 400', () => {
    const err = new ProviderError('openai', 400, '{"error":{"message":"invalid model ID"}}');
    const msg = describeError(err);
    expect(msg).toContain('invalid model ID');
    expect(msg).toContain('custom model');
  });
  it('should suggest checking the key on a 401', () => {
    expect(describeError(new ProviderError('anthropic', 401, 'unauthorized'))).toContain('API key');
  });
  it('should give a bare message on other statuses (no hint)', () => {
    const msg = describeError(new ProviderError('google', 500, 'server error'));
    expect(msg).toContain('500');
    expect(msg).not.toContain('custom model');
    expect(msg).not.toContain('API key');
  });
  it('should name the rejected model when present', () => {
    const msg = describeError(new ProviderError('openai', 400, 'invalid model ID', 'gpt-5-mini'));
    expect(msg).toContain('gpt-5-mini');
  });
  it('should fall back to a plain Error message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });
  it('should handle non-Error values', () => {
    expect(describeError('weird')).toBe('Something went wrong.');
  });
});
