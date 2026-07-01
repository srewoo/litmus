import { describe, it, expect } from 'vitest';
import { validateRubric } from './rubricValidation';
import type { Provider } from '../providers/types';
import type { CaseResult, EvalCase, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };
const cases: EvalCase[] = [{ id: 'c1', category: 'typical', input: 'hi', pinned: false }];

function result(id: string, score: number): CaseResult {
  return { caseId: id, output: 'o', score, passed: score >= 6, rationale: 'r', timing };
}

// Judge always returns 8 → consistency is perfect.
const provider: Provider = {
  id: 'google',
  async chat() {
    return { text: '{"score":8,"rationale":"r"}', timing };
  },
};

describe('validateRubric', () => {
  it('should return null for an empty run', async () => {
    expect(await validateRubric('SYS', cases, [], { provider, apiKey: 'sk', model: 'm', repeats: 1 })).toBeNull();
  });

  it('should compute good consistency from repeat judging and discrimination from the spread', async () => {
    const results = [result('c1', 8), result('a', 9), result('b', 3)];
    const health = await validateRubric('SYS', cases, results, { provider, apiKey: 'sk', model: 'm', repeats: 2 });
    expect(health).not.toBeNull();
    expect(health!.consistency.rating).toBe('good'); // [8,8,8] → σ0
    expect(health!.discrimination.gap).toBeGreaterThan(0); // top vs bottom of [9,8,3]
    expect((health!.discrimination as { insufficientData?: boolean }).insufficientData).toBeUndefined();
  });

  it('should base consistency on a real case, not an errored empty-output first result', async () => {
    const judged: string[] = [];
    const recording: Provider = {
      id: 'google',
      async chat(req) {
        judged.push(req.messages.map((m) => m.content).join('|'));
        return { text: '{"score":8,"rationale":"r"}', timing };
      },
    };
    const errored: CaseResult = { caseId: 'c1', output: '', score: 0, passed: false, rationale: 'Run failed: 429', timing };
    const good: CaseResult = { caseId: 'c2', output: 'REAL_OUTPUT', score: 8, passed: true, rationale: 'r', timing };
    const cases2: EvalCase[] = [
      { id: 'c1', category: 'typical', input: 'hi', pinned: false },
      { id: 'c2', category: 'typical', input: 'hello', pinned: false },
    ];
    const health = await validateRubric('SYS', cases2, [errored, good], {
      provider: recording, apiKey: 'sk', model: 'm', repeats: 1,
    });
    expect(health).not.toBeNull();
    // The re-judged output must be the case that actually produced text, not the empty errored one.
    expect(judged.some((j) => j.includes('REAL_OUTPUT'))).toBe(true);
  });

  it('should mark discrimination as insufficient for a single-case run', async () => {
    const health = await validateRubric('SYS', cases, [result('c1', 8)], {
      provider, apiKey: 'sk', model: 'm', repeats: 1,
    });
    expect(health).not.toBeNull();
    const disc = health!.discrimination as { gap: number; rating: string; insufficientData?: boolean; note?: string };
    expect(disc.insufficientData).toBe(true);
    expect(disc.gap).toBe(0);
    expect(disc.note).toMatch(/insufficient data/i);
    // Consistency is still computed normally.
    expect(health!.consistency.rating).toBe('good');
  });

  it('should mark discrimination as insufficient for a two-case run (thirds overlap)', async () => {
    const health = await validateRubric('SYS', cases, [result('c1', 8), result('a', 2)], {
      provider, apiKey: 'sk', model: 'm', repeats: 1,
    });
    expect(health).not.toBeNull();
    const disc = health!.discrimination as { gap: number; insufficientData?: boolean };
    expect(disc.insufficientData).toBe(true);
    expect(disc.gap).toBe(0);
  });
});
