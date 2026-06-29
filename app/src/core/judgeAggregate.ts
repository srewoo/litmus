/**
 * Reduce judge-variance dependence (a single LLM-judge call is noisy). Given N
 * independent verdicts on the SAME output, fold them into one robust verdict:
 * the score is the MEDIAN (resistant to a single outlier judge), dimensions are
 * per-dimension medians, and the run-to-run spread (stdev/min/max) is surfaced
 * so judge disagreement is visible instead of hidden behind one number. Pure and
 * deterministic — the LLM calls happen in the service; aggregation lives here so
 * it is unit-testable without a provider.
 */
import type { DimensionScore } from '../shared/types';
import { round1 } from '../shared/num';

/** The minimal verdict shape this module folds (matches the judge's Verdict). */
export interface VerdictLike {
  readonly score: number;
  readonly rationale: string;
  readonly dimensions?: readonly DimensionScore[];
}

/** Disagreement across the judge panel, so a noisy score isn't taken at face value. */
export interface JudgeSpread {
  readonly count: number;
  readonly scores: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly stdev: number;
}

export interface AggregatedVerdict {
  readonly score: number;
  readonly rationale: string;
  readonly dimensions?: readonly DimensionScore[];
  /** Present only when more than one verdict was folded. */
  readonly spread?: JudgeSpread;
}

/** Median of a non-empty number list (mean of the two middles when even). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return round1(m);
}

function stdev(values: readonly number[], mean: number): number {
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return round1(Math.sqrt(variance));
}

/**
 * Per-dimension median across verdicts, preserving the order dimensions first
 * appear in. A dimension absent from some verdicts is averaged over only the
 * verdicts that scored it.
 */
function aggregateDimensions(verdicts: readonly VerdictLike[]): DimensionScore[] | undefined {
  const order: string[] = [];
  const byDim = new Map<string, number[]>();
  for (const v of verdicts) {
    for (const d of v.dimensions ?? []) {
      if (!byDim.has(d.dimension)) {
        byDim.set(d.dimension, []);
        order.push(d.dimension);
      }
      byDim.get(d.dimension)!.push(d.score);
    }
  }
  if (order.length === 0) return undefined;
  return order.map((dimension) => ({ dimension, score: median(byDim.get(dimension)!) }));
}

/**
 * Fold N judge verdicts into one. A single verdict is returned essentially
 * unchanged (no spread). With N>1 the score is the median and a spread note is
 * appended to the rationale so disagreement is legible.
 */
export function aggregateVerdicts(verdicts: readonly VerdictLike[]): AggregatedVerdict {
  const first = verdicts[0];
  if (!first) throw new Error('aggregateVerdicts: no verdicts');
  if (verdicts.length === 1) {
    return first.dimensions
      ? { score: first.score, rationale: first.rationale, dimensions: first.dimensions }
      : { score: first.score, rationale: first.rationale };
  }

  const scores = verdicts.map((v) => v.score);
  const score = median(scores);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const mean = scores.reduce((a, s) => a + s, 0) / scores.length;
  const spread: JudgeSpread = { count: scores.length, scores, min, max, stdev: stdev(scores, mean) };

  const agreement = min === max ? `judges agreed at ${score}` : `${verdicts.length} judges: median ${score} (${min}–${max}, σ${spread.stdev})`;
  const dimensions = aggregateDimensions(verdicts);
  return {
    score,
    rationale: `${first.rationale} · ${agreement}`,
    ...(dimensions ? { dimensions } : {}),
    spread,
  };
}
