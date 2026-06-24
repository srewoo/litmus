/**
 * Rubric-validation statistics (PRD §8.7) — does a verdict mean anything?
 * Pure stats: discrimination power (easy vs hard score gap) and score
 * consistency (variance across repeat judging). Orchestration that gathers the
 * scores lives in a service; these functions make the math testable.
 */
import { mean, round1 } from '../shared/num';

export type Rating = 'good' | 'fair' | 'poor';

export interface ConsistencyResult {
  readonly stdDev: number;
  readonly rating: Rating;
}

export interface DiscriminationResult {
  readonly gap: number;
  readonly rating: Rating;
}

export interface RubricHealth {
  readonly consistency: ConsistencyResult;
  readonly discrimination: DiscriminationResult;
}

/** Population standard deviation. 0 for fewer than two samples. */
export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

/** Lower spread = more trustworthy. good ≤0.5, fair ≤1.0, else poor. */
export function consistency(repeatScores: readonly number[]): ConsistencyResult {
  const sd = round1(stdDev(repeatScores));
  const rating: Rating = sd <= 0.5 ? 'good' : sd <= 1.0 ? 'fair' : 'poor';
  return { stdDev: sd, rating };
}

/** Bigger easy-vs-hard gap = the rubric separates quality. good ≥1.5, fair ≥0.5, else poor. */
export function discrimination(
  easyScores: readonly number[],
  hardScores: readonly number[],
): DiscriminationResult {
  const gap = round1(mean(easyScores) - mean(hardScores));
  const rating: Rating = gap >= 1.5 ? 'good' : gap >= 0.5 ? 'fair' : 'poor';
  return { gap, rating };
}
