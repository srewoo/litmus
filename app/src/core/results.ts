/** Pure result aggregation: turn per-case results into a run summary (quality + speed). */
import type { CaseResult, RunSummary } from '../shared/types';
import { round1 } from '../shared/num';
import { aggregateSpeed } from './timing';

/** Default pass bar; overridable via Settings.passThreshold. */
export const DEFAULT_PASS_THRESHOLD = 6;

export function scorePasses(score: number, threshold: number = DEFAULT_PASS_THRESHOLD): boolean {
  return score >= threshold;
}

/**
 * Summarize a run. `overall` is the mean case score; pass/fail is computed from
 * the threshold (not from each result's `passed` flag) so a single threshold is
 * authoritative across the whole run.
 */
export function summarizeRun(
  results: readonly CaseResult[],
  threshold: number = DEFAULT_PASS_THRESHOLD,
): RunSummary {
  const total = results.length;
  if (total === 0) {
    return { overall: 0, passCount: 0, failCount: 0, total: 0, speed: aggregateSpeed([]) };
  }
  const overall = round1(results.reduce((acc, r) => acc + r.score, 0) / total);
  const passCount = results.filter((r) => scorePasses(r.score, threshold)).length;
  return {
    overall,
    passCount,
    failCount: total - passCount,
    total,
    speed: aggregateSpeed(results.map((r) => r.timing)),
  };
}

/** Failing cases first, then by ascending score — the order the fix list consumes. */
export function failingFirst(
  results: readonly CaseResult[],
  threshold: number = DEFAULT_PASS_THRESHOLD,
): CaseResult[] {
  return [...results].sort((a, b) => {
    const aFail = scorePasses(a.score, threshold) ? 1 : 0;
    const bFail = scorePasses(b.score, threshold) ? 1 : 0;
    if (aFail !== bFail) return aFail - bFail;
    return a.score - b.score;
  });
}
