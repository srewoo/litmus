import { describe, it, expect } from 'vitest';
import { scorePasses, summarizeRun, failingFirst, foldSamples } from './results';
import type { CaseResult, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 100, totalMs: 1000, tokens: 10, tokensPerSec: 10 };

function result(caseId: string, score: number, passed = score >= 6): CaseResult {
  return { caseId, output: 'o', score, passed, rationale: 'r', timing };
}

describe('foldSamples', () => {
  it('returns the single run unchanged when N=1', () => {
    const folded = foldSamples([result('c1', 8)]);
    expect(folded.score).toBe(8);
    expect(folded.samples).toBeUndefined();
  });
  it('averages scores and records the spread across runs', () => {
    const folded = foldSamples([result('c1', 9), result('c1', 6), result('c1', 9)]);
    expect(folded.score).toBe(8); // mean(9,6,9)
    expect(folded.samples).toMatchObject({ count: 3, min: 6, max: 9, passRate: 1 });
    expect(folded.passed).toBe(true);
    expect(folded.rationale).toMatch(/3 runs/);
  });
  it('fails the case when most samples fall below the threshold', () => {
    const folded = foldSamples([result('c1', 3), result('c1', 8), result('c1', 2)], 6);
    expect(folded.passed).toBe(false); // only 1 of 3 passed
    expect(folded.samples?.passRate).toBeCloseTo(1 / 3);
  });
  it('honours each run\'s passed flag rather than re-thresholding its score', () => {
    // Agent-scenario runs can score high yet fail deterministically (e.g. goal
    // reached but an invalid-arg tool call → score 9.5, passed false).
    const folded = foldSamples([result('c1', 9.5, false), result('c1', 9.5, false), result('c1', 9.5, true)], 6);
    expect(folded.passed).toBe(false); // majority of runs FAILED despite high scores
    expect(folded.samples?.passRate).toBeCloseTo(1 / 3);
    expect(folded.score).toBe(9.5); // mean score is still reported
  });
  it('averages per-dimension scores across samples, tolerating runs without them', () => {
    const runs: CaseResult[] = [
      { ...result('c1', 8), dimensions: [{ dimension: 'tone', score: 8 }, { dimension: 'format', score: 6 }] },
      { ...result('c1', 6), dimensions: [{ dimension: 'tone', score: 4 }] }, // format missing here
      result('c1', 7), // no dimensions at all
    ];
    const folded = foldSamples(runs);
    expect(folded.dimensions).toEqual([
      { dimension: 'tone', score: 6 }, // mean(8, 4)
      { dimension: 'format', score: 6 }, // only sample 1 scored it
    ]);
  });
  it('keeps dimensions undefined when the first run has none', () => {
    const folded = foldSamples([result('c1', 8), { ...result('c1', 6), dimensions: [{ dimension: 'tone', score: 5 }] }]);
    expect(folded.dimensions).toBeUndefined();
  });
});

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

  it('should compute overall mean and count pass/fail from the per-case flag', () => {
    const s = summarizeRun([result('a', 9), result('b', 3), result('c', 6)]);
    expect(s.overall).toBe(6); // mean(9,3,6)
    expect(s.passCount).toBe(2); // a and c passed
    expect(s.failCount).toBe(1); // b failed
    expect(s.total).toBe(3);
  });

  it('should derive counts from the per-case flag, not by re-thresholding the score', () => {
    // The flag is the single source of truth: a custom threshold was already
    // applied upstream when `passed` was set. Here case 'a' (score 7) was failed.
    const s = summarizeRun([result('a', 7, false), result('b', 9, true)]);
    expect(s.passCount).toBe(1);
    expect(s.failCount).toBe(1);
  });

  it('should agree with the per-case flag for a sampled case (majority vote)', () => {
    // foldSamples of [10,5,5] @6 → mean 6.67, but only 1/3 samples pass → passed=false.
    // summarizeRun must honour that flag, not re-threshold the mean (which would "pass").
    const folded = foldSamples([result('s', 10), result('s', 5), result('s', 5)], 6);
    expect(folded.passed).toBe(false);
    expect(folded.score).toBeGreaterThanOrEqual(6); // mean would re-threshold as a pass
    const s = summarizeRun([folded], 6);
    expect(s.passCount).toBe(0); // headline agrees with the per-case fail
    expect(s.failCount).toBe(1);
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
