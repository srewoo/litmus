import { describe, it, expect } from 'vitest';
import { scorePasses, summarizeRun, failingFirst } from './results';
import type { CaseResult, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 100, totalMs: 1000, tokens: 10, tokensPerSec: 10 };

function result(caseId: string, score: number): CaseResult {
  return { caseId, output: 'o', score, passed: score >= 6, rationale: 'r', timing };
}

describe('scorePasses', () => {
  it('should pass at or above the threshold (boundary inclusive)', () => {
    expect(scorePasses(6)).toBe(true);
    expect(scorePasses(5.9)).toBe(false);
  });
  it('should honor a custom threshold', () => {
    expect(scorePasses(7, 8)).toBe(false);
  });
});

describe('summarizeRun', () => {
  it('should return an empty summary for no results', () => {
    const s = summarizeRun([]);
    expect(s).toMatchObject({ overall: 0, passCount: 0, failCount: 0, total: 0 });
  });

  it('should compute overall mean and pass/fail from the threshold', () => {
    const s = summarizeRun([result('a', 9), result('b', 3), result('c', 6)]);
    expect(s.overall).toBe(6); // mean(9,3,6)
    expect(s.passCount).toBe(2); // 9 and 6
    expect(s.failCount).toBe(1); // 3
    expect(s.total).toBe(3);
  });

  it('should respect a custom threshold', () => {
    const s = summarizeRun([result('a', 7), result('b', 9)], 8);
    expect(s.passCount).toBe(1);
  });
});

describe('failingFirst', () => {
  it('should put failures first, then order by ascending score', () => {
    const ordered = failingFirst([result('a', 9), result('b', 3), result('c', 4.5)]);
    expect(ordered.map((r) => r.caseId)).toEqual(['b', 'c', 'a']);
  });
  it('should not mutate the input array', () => {
    const input = [result('a', 9), result('b', 3)];
    failingFirst(input);
    expect(input.map((r) => r.caseId)).toEqual(['a', 'b']);
  });
});
