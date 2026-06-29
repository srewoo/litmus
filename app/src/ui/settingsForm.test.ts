import { describe, it, expect } from 'vitest';
import { mergeSettings } from './settingsForm';
import { SettingsSchema } from '../shared/schema';

const current = SettingsSchema.parse({ keys: { openai: 'sk-old' }, passThreshold: 6, spendCapUsd: 0.5 });

describe('mergeSettings', () => {
  it('should keep an existing key when its field is blank', () => {
    const next = mergeSettings(current, { keys: { openai: '' } });
    expect(next.keys.openai).toBe('sk-old');
  });
  it('should overwrite a key when a new value is typed, trimming whitespace', () => {
    const next = mergeSettings(current, { keys: { openai: '  sk-new  ' } });
    expect(next.keys.openai).toBe('sk-new');
  });
  it('should add keys for other providers without touching existing ones', () => {
    const next = mergeSettings(current, { keys: { anthropic: 'sk-a' } });
    expect(next.keys).toMatchObject({ openai: 'sk-old', anthropic: 'sk-a' });
  });
  it('should update threshold, cap, and default target', () => {
    const next = mergeSettings(current, {
      keys: {},
      passThreshold: 7,
      spendCapUsd: 1.5,
      defaultTarget: { provider: 'google', model: 'gemini-2.5-pro' },
    });
    expect(next.passThreshold).toBe(7);
    expect(next.spendCapUsd).toBe(1.5);
    expect(next.defaultTarget?.model).toBe('gemini-2.5-pro');
  });
  it('should fall back to current values when fields are omitted', () => {
    const next = mergeSettings(current, { keys: {} });
    expect(next.passThreshold).toBe(6);
    expect(next.spendCapUsd).toBe(0.5);
  });
  it('should reject an out-of-range threshold', () => {
    expect(() => mergeSettings(current, { keys: {}, passThreshold: 50 })).toThrow();
  });
  it('should set, keep, and clear the judge override', () => {
    const set = mergeSettings(current, { keys: {}, judgeModel: 'gpt-5.4-mini' });
    expect(set.judgeModel).toBe('gpt-5.4-mini');
    const kept = mergeSettings(set, { keys: {} });
    expect(kept.judgeModel).toBe('gpt-5.4-mini');
    const cleared = mergeSettings(set, { keys: {}, judgeModel: '' });
    expect(cleared.judgeModel).toBeUndefined();
  });
  it('should store a custom model id', () => {
    expect(mergeSettings(current, { keys: {}, customModel: 'openai/gpt-5.4' }).customModel).toBe('openai/gpt-5.4');
  });
  it('should set and then preserve judgeSamples and concurrency', () => {
    const set = mergeSettings(current, { keys: {}, judgeSamples: 3, concurrency: 4 });
    expect(set.judgeSamples).toBe(3);
    expect(set.concurrency).toBe(4);
    const kept = mergeSettings(set, { keys: {} }); // omitted → must not reset to default
    expect(kept.judgeSamples).toBe(3);
    expect(kept.concurrency).toBe(4);
  });
  it('should reject out-of-range judgeSamples and concurrency', () => {
    expect(() => mergeSettings(current, { keys: {}, judgeSamples: 9 })).toThrow();
    expect(() => mergeSettings(current, { keys: {}, concurrency: 99 })).toThrow();
  });
});
