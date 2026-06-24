import { describe, it, expect } from 'vitest';
import { buildJudgeMessages, parseVerdict, judgeOutput } from './judge';
import type { Provider } from '../providers/types';

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
});
