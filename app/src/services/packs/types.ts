/**
 * Shared verdict shape + fold for the media evaluator packs (ADR 0007).
 *
 * Every pack's pure `check*` returns a CheckResult in the same shape the run
 * layer folds into a CaseResult — so `foldSamples`/`summarizeRun`/the litmus axis
 * need no media-specific code. A pack accumulates:
 *   - `reasons`: deterministic FAILURES (a hard gate broke, or a content check
 *     missed its threshold). Any reason blocks the pass.
 *   - `checks`:  a 0–10 dimension per content check, for the version axis.
 * The fold mirrors scoreScenario's fail-safe: if anything failed, score is 0 and
 * passed is false (a broken artifact earns no partial credit for content it
 * happens to contain); otherwise score is the mean of the content dimensions.
 */
import type { DimensionScore } from '../../shared/types';
import { round1, mean } from '../../shared/num';

export interface CheckResult {
  readonly passed: boolean;
  /** 0–10 deterministic score (mean of content dimensions, or 0 on any failure). */
  readonly score: number;
  readonly reasons: readonly string[];
  /** Per-check dimensions, feeding the litmus axis (also present when failing). */
  readonly dimensions: readonly DimensionScore[];
}

/** One content check's contribution: a 0–10 dimension for the axis. */
export interface Check {
  readonly dimension: string;
  readonly score: number;
}

export function foldChecks(reasons: readonly string[], checks: readonly Check[]): CheckResult {
  const dimensions: DimensionScore[] = checks.map((c) => ({ dimension: c.dimension, score: c.score }));
  const passed = reasons.length === 0;
  const score = passed ? (dimensions.length ? round1(mean(dimensions.map((d) => d.score))) : 10) : 0;
  return { passed, score, reasons, dimensions };
}

/** One-line human summary for a case rationale (mirrors describeToolAssert). */
export function describeCheck(kind: string, result: CheckResult): string {
  return result.passed
    ? `${kind} checks passed (score ${result.score}/10).`
    : `${kind} check failed: ${result.reasons.join('; ')}`;
}
