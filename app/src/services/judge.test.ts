import { describe, it, expect } from 'vitest';
import { buildJudgeMessages, parseVerdict, judgeOutput, judgeOutputEnsemble } from './judge';
import type { Provider } from '../providers/types';

const timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };

describe('buildJudgeMessages', () => {
  it('should include the system prompt, input, and output', () => {
    const msgs = buildJudgeMessages('SYS', 'INPUT', 'OUTPUT');
    expect(msgs[1]?.content).toContain('SYS');
    expect(msgs[1]?.content).toContain('INPUT');
    expect(msgs[1]?.content).toContain('OUTPUT');
  });
  it('should apply a provided rubric instead of the generic instruction', () => {
    const msgs = buildJudgeMessages('SYS', 'IN', 'OUT', 'SECTION 0: INPUT DATA … fail-safe logic');
    expect(msgs[0]?.content).toContain('EVALUATION RUBRIC');
    expect(msgs[0]?.content).toContain('SECTION 0: INPUT DATA');
  });
});

describe('parseVerdict', () => {
  it('should parse score, rationale, and optional dimensions', () => {
    const v = parseVerdict('{"score":8.4,"rationale":"good","dimensions":[{"dimension":"format","score":9}]}');
    expect(v.score).toBe(8.4);
    expect(v.dimensions?.[0]?.dimension).toBe('format');
  });
  it('should accept a verdict without dimensions', () => {
    expect(parseVerdict('{"score":5,"rationale":"meh"}').dimensions).toBeUndefined();
  });
  it('should reject a score above 10', () => {
    expect(() => parseVerdict('{"score":11,"rationale":"x"}')).toThrow();
  });
});

describe('judgeOutput', () => {
  it('should call the judge model and return the verdict', async () => {
    let model = '';
    const provider: Provider = {
      id: 'google',
      async chat(req) {
        model = req.model;
        return { text: '{"score":7,"rationale":"ok"}', timing: { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 } };
      },
    };
    const v = await judgeOutput('SYS', 'IN', 'OUT', { provider, apiKey: 'sk', model: 'gemini-2.5-pro' });
    expect(v.score).toBe(7);
    expect(model).toBe('gemini-2.5-pro');
  });

  it('should judge at temperature 0 for a single call', async () => {
    let temp: number | undefined = -1;
    const provider: Provider = {
      id: 'google',
      async chat(req) {
        temp = req.temperature;
        return { text: '{"score":7,"rationale":"ok"}', timing };
      },
    };
    await judgeOutput('SYS', 'IN', 'OUT', { provider, apiKey: 'sk', model: 'm' });
    expect(temp).toBe(0);
  });
});

describe('judgeOutputEnsemble', () => {
  it('should make one temp-0 call and report no spread when judgeSamples <= 1', async () => {
    let calls = 0;
    let temp: number | undefined = -1;
    const provider: Provider = {
      id: 'google',
      async chat(req) {
        calls++;
        temp = req.temperature;
        return { text: '{"score":6,"rationale":"r"}', timing };
      },
    };
    const v = await judgeOutputEnsemble('SYS', 'IN', 'OUT', { provider, apiKey: 'sk', model: 'm', judgeSamples: 1 });
    expect(calls).toBe(1);
    expect(temp).toBe(0);
    expect(v.score).toBe(6);
    expect(v.spread).toBeUndefined();
  });

  it('should run N judges at non-zero temperature and fold to the median, ignoring an outlier', async () => {
    const scores = [8, 8, 1]; // an outlier judge that the median should resist
    let i = 0;
    let temp: number | undefined = -1;
    const provider: Provider = {
      id: 'google',
      async chat(req) {
        temp = req.temperature;
        const s = scores[i++] ?? 8;
        return { text: `{"score":${s},"rationale":"r"}`, timing };
      },
    };
    const v = await judgeOutputEnsemble('SYS', 'IN', 'OUT', { provider, apiKey: 'sk', model: 'm', judgeSamples: 3 });
    expect(i).toBe(3); // three judge calls
    expect(temp).toBeGreaterThan(0); // ensemble varies the temperature
    expect(v.score).toBe(8); // median(8,8,1)
    expect(v.spread).toMatchObject({ count: 3, min: 1, max: 8 });
  });

  it('should honor an explicit judgeTemperature', async () => {
    let temp: number | undefined = -1;
    const provider: Provider = {
      id: 'google',
      async chat(req) {
        temp = req.temperature;
        return { text: '{"score":7,"rationale":"r"}', timing };
      },
    };
    await judgeOutputEnsemble('SYS', 'IN', 'OUT', { provider, apiKey: 'sk', model: 'm', judgeSamples: 2, judgeTemperature: 0.9 });
    expect(temp).toBe(0.9);
  });
});
