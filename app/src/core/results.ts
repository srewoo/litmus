/** Pure result aggregation: turn per-case results into a run summary (quality + speed). */
import type { CaseResult, RunSummary, SampleStats } from '../shared/types';
import { round1 } from '../shared/num';
import { aggregateSpeed } from './timing';

/** Default pass bar; overridable via Settings.passThreshold. */
export const DEFAULT_PASS_THRESHOLD = 6;

export function scorePasses(score: number, threshold: number = DEFAULT_PASS_THRESHOLD): boolean {
  return score >= threshold;
}

/**
 * Fold N repeated runs of the same case into one CaseResult, capturing run-to-run
 * spread. Aggregated score is the mean; the case passes if the MAJORITY of samples
 * passed. With a single run, returns it unchanged (no samples block).
 */
export function foldSamples(runs: readonly CaseResult[], threshold: number = DEFAULT_PASS_THRESHOLD): CaseResult {
  const first = runs[0];
  if (!first) throw new Error('foldSamples: no runs');
  if (runs.length === 1) return first;
  const scores = runs.map((r) => r.score);
  const mean = round1(scores.reduce((a, b) => a + b, 0) / scores.length);
  const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length;
  const passRate = runs.filter((r) => scorePasses(r.score, threshold)).length / runs.length;
  const stats: SampleStats = {
    count: runs.length,
    scores,
    mean,
    min: Math.min(...scores),
    max: Math.max(...scores),
    stdev: round1(Math.sqrt(variance)),
    passRate,
  };
  const spread = stats.min === stats.max ? `stable at ${mean}` : `${stats.min}–${stats.max}, σ${stats.stdev}`;
  return {
    ...first,
    score: mean,
    passed: passRate >= 0.5,
    rationale: `${first.rationale} · ${runs.length} runs (${spread})`,
    samples: stats,
  };
}

/**
 * Summarize a run. `overall` is the mean case score; pass/fail is taken from the
 * per-case `passed` flag, which is the SINGLE source of truth (set by
 * `runOneCase`/`foldSamples` against the run threshold). This keeps the headline
 * counts consistent with the per-case verdicts, including sampled cases where a
 * majority-of-samples vote can disagree with re-thresholding the mean score.
 *
 * The `threshold` parameter is retained for backward compatibility but no longer
 * affects pass/fail — the per-case flag already encodes it.
 */
export function summarizeRun(
  results: readonly CaseResult[],
  _threshold: number = DEFAULT_PASS_THRESHOLD,
): RunSummary {
  const total = results.length;
  if (total === 0) {
    return { overall: 0, passCount: 0, failCount: 0, total: 0, speed: aggregateSpeed([]) };
  }
  const overall = round1(results.reduce((acc, r) => acc + r.score, 0) / total);
  const passCount = results.filter((r) => r.passed).length;
  return {
    overall,
    passCount,
    failCount: total - passCount,
    total,
    speed: aggregateSpeed(results.map((r) => r.timing)),
  };
}

/**
 * Failing cases first, then by ascending score — the order the fix list consumes.
 * Ordering uses the per-case `passed` flag (the single source of truth), so it
 * agrees with `summarizeRun`. The `threshold` parameter is retained for backward
 * compatibility but no longer affects ordering.
 */
export function failingFirst(
  results: readonly CaseResult[],
  _threshold: number = DEFAULT_PASS_THRESHOLD,
): CaseResult[] {
  return [...results].sort((a, b) => {
    const aFail = a.passed ? 1 : 0;
    const bFail = b.passed ? 1 : 0;
    if (aFail !== bFail) return aFail - bFail;
    return a.score - b.score;
  });
}
