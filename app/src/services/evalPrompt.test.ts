import { describe, it, expect } from 'vitest';
import { buildEvalPromptMessages, generateEvalPrompt } from './evalPrompt';
import type { Provider } from '../providers/types';

describe('buildEvalPromptMessages', () => {
  it('should demand all eight sections and the key enforcement rules', () => {
    const sys = buildEvalPromptMessages('You are a judge.', 'behavioral_clarity')[0]?.content ?? '';
    expect(sys).toContain('SECTION 0');
    expect(sys).toContain('SECTION 7');
    expect(sys).toContain('FAILURES TO FLAG');
    expect(sys).toContain('FAIL-SAFE');
    expect(sys).toContain('STEP 0');
    expect(sys).toContain('≥2 supporting signals');
    expect(sys).toContain('behavioral_clarity');
  });
  it('should forbid duplicate eval conditions and un-computable thresholds', () => {
    const sys = buildEvalPromptMessages('You are a judge.', 'coherence')[0]?.content ?? '';
    expect(sys).toContain('ORTHOGONAL SUB-CRITERIA (MECE)');
    expect(sys).toContain('Distinctness:');
    expect(sys).toContain('mutually exclusive');
    expect(sys).toContain('OBSERVABLE THRESHOLDS');
    expect(sys).toContain('SELF-REVIEW');
  });
  it('should carry the system prompt as the user turn and embed the hint', () => {
    const msgs = buildEvalPromptMessages('SYS', '', 'format: expects user_query and generated_answer');
    expect(msgs[1]).toEqual({ role: 'user', content: 'SYS' });
    expect(msgs[0]?.content).toContain('user_query and generated_answer');
  });
});

const STRONG_RUBRIC = [
  'SECTION 0: INPUT DATA',
  'SECTION 1: evaluate ONLY clarity. The transcript is the definitive source of truth.',
  'SECTION 2: sub-criteria are mutually exclusive. Distinctness: covers wording, leaves alignment to a sibling. FAILURES TO FLAG: vague claims. Threshold ≥2 distinct snippets.',
  'SECTION 3: STRONG / ACCEPTABLE / WEAK / FAIL. Fail-safe: lowest sub-score wins.',
  'SECTION 4: STEP 0 evidence extraction before any scoring. Evidence verbatim & traceable, located by field path output_parsed.short_reason. ≥2 signals.',
  'SECTION 5: issues with Impact and Location.',
  'SECTION 6: Example 1: STRONG',
  'SECTION 7: QUALITY CHECKLIST [ ]',
].join('\n');

describe('generateEvalPrompt', () => {
  it('should return a strong rubric immediately when it clears the bar', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: STRONG_RUBRIC, timing: { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 } };
      },
    };
    const out = await generateEvalPrompt('SYS', 'clarity', { provider, apiKey: 'sk', model: 'gpt-4o' });
    expect(out).toContain('SECTION 7');
  });

  it('should refine: regenerate after a weak draft and keep the better one', async () => {
    let call = 0;
    const provider: Provider = {
      id: 'openai',
      async chat() {
        call += 1;
        return {
          text: call === 1 ? 'just score it 1-10' : STRONG_RUBRIC,
          timing: { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 },
        };
      },
    };
    const out = await generateEvalPrompt('SYS', 'clarity', { provider, apiKey: 'sk', model: 'm' }, undefined, 1);
    expect(call).toBe(2); // refined once
    expect(out).toContain('SECTION 7'); // kept the strong draft
  });
});
