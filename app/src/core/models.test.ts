import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG, PROVIDER_ORDER, DEFAULT_TARGET_VALUE, PROVIDER_LABEL } from './models';

describe('MODEL_CATALOG', () => {
  it('should offer at least four models per family', () => {
    for (const provider of PROVIDER_ORDER) {
      expect(MODEL_CATALOG[provider].length).toBeGreaterThanOrEqual(4);
    }
  });
  it('should not include the non-existent gpt-5.1-mini id', () => {
    expect(MODEL_CATALOG.openai.some((m) => m.id === 'gpt-5.1-mini')).toBe(false);
  });
  it('should use dashed Anthropic API ids', () => {
    expect(MODEL_CATALOG.anthropic.some((m) => m.id === 'claude-sonnet-4-6')).toBe(true);
  });
  it('should have a label for every provider and a valid default', () => {
    for (const provider of PROVIDER_ORDER) expect(PROVIDER_LABEL[provider]).toBeTruthy();
    expect(DEFAULT_TARGET_VALUE).toContain('/');
  });
});
