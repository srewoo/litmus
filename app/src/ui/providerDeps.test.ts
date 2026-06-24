import { describe, it, expect } from 'vitest';
import { resolveJudgeModel, buildWiring } from './providerDeps';
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
