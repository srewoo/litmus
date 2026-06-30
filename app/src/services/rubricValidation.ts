/**
 * Rubric validation wired into a run (PRD F5 / §8.7). Computes:
 *  - consistency: re-judge one case `repeats` extra times → score std-dev.
 *  - discrimination: gap between the top and bottom thirds of the run's scores
 *    (a rubric that scores everything alike does not discriminate).
 */
import type { CaseResult, EvalCase } from '../shared/types';
import type { Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import type { RubricHealth, DiscriminationResult } from '../core/rubric';
import { consistency, discrimination } from '../core/rubric';
import { judgeOutput } from './judge';

/**
 * Discrimination needs at least 3 scores so the top and bottom thirds don't
 * overlap. For shorter runs we surface a clearly-marked "insufficient data"
 * result (rating 'poor', gap 0, plus a `note`) instead of a misleading 0 gap
 * computed from identical top/bottom slices.
 */
export interface InsufficientDiscrimination extends DiscriminationResult {
  readonly insufficientData: true;
  readonly note: string;
}

const MIN_DISCRIMINATION_SAMPLES = 3;

export interface ValidateDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly rubric?: string;
  /** Extra judge passes for the consistency check (default 2). */
  readonly repeats?: number;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export async function validateRubric(
  systemPrompt: string,
  cases: readonly EvalCase[],
  results: readonly CaseResult[],
  deps: ValidateDeps,
): Promise<RubricHealth | null> {
  const target = results[0];
  if (!target) return null;

  const input = cases.find((c) => c.id === target.caseId)?.input ?? '';
  const scores: number[] = [target.score];
  const repeats = deps.repeats ?? 2;
  for (let i = 0; i < repeats; i++) {
    const verdict = await judgeOutput(systemPrompt, input, target.output, {
      provider: deps.provider,
      apiKey: deps.apiKey,
      model: deps.model,
      rubric: deps.rubric,
      fetchImpl: deps.fetchImpl,
      clock: deps.clock,
      signal: deps.signal,
    });
    scores.push(verdict.score);
  }

  const sorted = results.map((r) => r.score).sort((a, b) => b - a);
  const consistencyResult = consistency(scores);

  // Guard: with fewer than 3 scores the top/bottom thirds overlap (identical
  // slices), so any computed gap is 0 and misleading. Mark it as insufficient.
  if (sorted.length < MIN_DISCRIMINATION_SAMPLES) {
    const insufficient: InsufficientDiscrimination = {
      gap: 0,
      rating: 'poor',
      insufficientData: true,
      note: `insufficient data: need ≥${MIN_DISCRIMINATION_SAMPLES} cases to measure discrimination (got ${sorted.length})`,
    };
    return { consistency: consistencyResult, discrimination: insufficient };
  }

  const k = Math.max(1, Math.floor(sorted.length / 3));
  const top = sorted.slice(0, k);
  const bottom = sorted.slice(sorted.length - k);

  return { consistency: consistencyResult, discrimination: discrimination(top, bottom) };
}
