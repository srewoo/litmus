import { describe, it, expect } from 'vitest';
import { parseTarget } from './target';

describe('parseTarget', () => {
  it('should split provider and model', () => {
    expect(parseTarget('openai/gpt-5.1')).toEqual({ provider: 'openai', model: 'gpt-5.1' });
  });
  it('should keep slashes inside the model id', () => {
    expect(parseTarget('google/models/gemini-2.5-pro')).toEqual({
      provider: 'google',
      model: 'models/gemini-2.5-pro',
    });
  });
  it('should reject an unknown provider', () => {
    expect(() => parseTarget('cohere/command')).toThrow();
  });
  it('should reject a missing model', () => {
    expect(() => parseTarget('openai/')).toThrow();
  });
  it('should reject a bare value with no slash', () => {
    expect(() => parseTarget('openai')).toThrow();
  });
});
