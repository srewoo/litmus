import { describe, it, expect } from 'vitest';
import { resolveJudgeModel, resolveVisionModel, resolveArchitectModel, buildWiring } from './providerDeps';
import { SettingsSchema } from '../shared/schema';
import type { Provider } from '../providers/types';
import type { ProviderId, TargetModel } from '../shared/types';

const stub: Provider = {
  id: 'openai',
  async chat() {
    return { text: '', timing: { ttfbMs: 0, totalMs: 0, tokens: 0, tokensPerSec: 0 } };
  },
};
const factory = (_id: ProviderId): Provider => stub;
const target: TargetModel = { provider: 'openai', model: 'gpt-5.5' };

describe('resolveJudgeModel', () => {
  it('should default the judge to the target model', () => {
    expect(resolveJudgeModel(SettingsSchema.parse({}), target)).toBe('gpt-5.5');
  });
  it('should honor an explicit bare judge override', () => {
    expect(resolveJudgeModel(SettingsSchema.parse({ judgeModel: 'gpt-5.4-mini' }), target)).toBe('gpt-5.4-mini');
  });
  it('should strip a legacy "provider/model" override', () => {
    expect(resolveJudgeModel(SettingsSchema.parse({ judgeModel: 'openai/gpt-5.1' }), target)).toBe('gpt-5.1');
  });
  it('should auto-heal to the target when the override is not in the key\'s models', () => {
    const settings = SettingsSchema.parse({
      judgeModel: 'gpt-5.1',
      availableModels: { openai: ['gpt-5-mini', 'gpt-4o'] },
    });
    expect(resolveJudgeModel(settings, target)).toBe('gpt-5.5'); // gpt-5.1 not available → fall back
  });
  it('should keep the override when it is in the key\'s models', () => {
    const settings = SettingsSchema.parse({
      judgeModel: 'gpt-4o',
      availableModels: { openai: ['gpt-5.5', 'gpt-4o'] },
    });
    expect(resolveJudgeModel(settings, target)).toBe('gpt-4o');
  });
});

describe('resolveVisionModel (image describer, ADR 0007)', () => {
  it('should use the user-selected judge model when it is a vision chat model', () => {
    // The reported issue: don't hardcode gpt-4o — use the model the user picked.
    expect(resolveVisionModel(SettingsSchema.parse({ judgeModel: 'gpt-5-mini' }))).toBe('gpt-5-mini');
    expect(resolveVisionModel(SettingsSchema.parse({ judgeModel: 'openai/gpt-5.1' }))).toBe('gpt-5.1');
  });

  it('should skip a judge model that is itself an image generator, and use the default target', () => {
    const settings = SettingsSchema.parse({
      judgeModel: 'gpt-image-1', // not a vision chat model
      defaultTarget: { provider: 'openai', model: 'gpt-5-mini' },
    });
    expect(resolveVisionModel(settings)).toBe('gpt-5-mini');
  });

  it('should fall back to a discovered OpenAI chat model, then gpt-4o', () => {
    const discovered = SettingsSchema.parse({ availableModels: { openai: ['dall-e-3', 'gpt-5.1-mini'] } });
    expect(resolveVisionModel(discovered)).toBe('gpt-5.1-mini'); // skips the image model
    expect(resolveVisionModel(SettingsSchema.parse({}))).toBe('gpt-4o'); // nothing selected → fallback
  });

  it('should not use a non-OpenAI default target (the describer runs on the OpenAI key)', () => {
    const settings = SettingsSchema.parse({ defaultTarget: { provider: 'google', model: 'gemini-2.5-pro' } });
    expect(resolveVisionModel(settings)).toBe('gpt-4o');
  });
});

describe('resolveArchitectModel (prompt builder)', () => {
  it('should use the target when it is a chat model (common case, unchanged)', () => {
    expect(resolveArchitectModel(SettingsSchema.parse({}), { provider: 'openai', model: 'gpt-5.5' })).toBe('gpt-5.5');
  });

  it('should NOT run on an image target — fall back to the judge/default chat model', () => {
    const imageTarget = { provider: 'openai' as const, model: 'gpt-image-1' };
    // judge override wins
    expect(resolveArchitectModel(SettingsSchema.parse({ judgeModel: 'gpt-5-mini' }), imageTarget)).toBe('gpt-5-mini');
    // else default target on the same provider
    const def = SettingsSchema.parse({ defaultTarget: { provider: 'openai', model: 'gpt-4.1' } });
    expect(resolveArchitectModel(def, imageTarget)).toBe('gpt-4.1');
  });

  it('should fall back to a discovered chat model, then the per-provider default', () => {
    const discovered = SettingsSchema.parse({ availableModels: { openai: ['gpt-image-1', 'gpt-5'] } });
    expect(resolveArchitectModel(discovered, { provider: 'openai', model: 'gpt-image-1' })).toBe('gpt-5');
    expect(resolveArchitectModel(SettingsSchema.parse({}), { provider: 'openai', model: 'gpt-image-1' })).toBe('gpt-5.5');
    expect(resolveArchitectModel(SettingsSchema.parse({}), { provider: 'anthropic', model: 'flux-1' })).toBe('claude-sonnet-4-6');
  });
});

describe('buildWiring', () => {
  it('should wire both roles to the provider key, judge defaulting to the target model', () => {
    const settings = SettingsSchema.parse({ keys: { openai: 'sk-x' } });
    const w = buildWiring(settings, target, factory);
    expect(w.targetKey).toBe('sk-x');
    expect(w.judgeKey).toBe('sk-x');
    expect(w.auxModel).toBe('gpt-5.5');
  });
  it('should support non-OpenAI providers when keyed', () => {
    const settings = SettingsSchema.parse({ keys: { anthropic: 'sk-a' } });
    const w = buildWiring(settings, { provider: 'anthropic', model: 'claude-sonnet-4-6' }, factory);
    expect(w.auxModel).toBe('claude-sonnet-4-6');
  });
  it('should throw when the target provider has no key', () => {
    const settings = SettingsSchema.parse({ keys: { openai: 'sk-x' } });
    expect(() => buildWiring(settings, { provider: 'google', model: 'gemini-3.5-pro' }, factory)).toThrow();
  });
});
