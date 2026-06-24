/**
 * Rubric validation wired into a run (PRD F5 / §8.7). Computes:
 *  - consistency: re-judge one case `repeats` extra times → score std-dev.
 *  - discrimination: gap between the top and bottom thirds of the run's scores
 *    (a rubric that scores everything alike does not discriminate).
 */
import type { CaseResult, EvalCase } from '../shared/types';
import type { Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import type { RubricHealth } from '../core/rubric';
import { consistency, discrimination } from '../core/rubric';
import { judgeOutput } from './judge';

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
  const k = Math.max(1, Math.floor(sorted.length / 3));
  const top = sorted.slice(0, k);
  const bottom = sorted.slice(sorted.length - k);

  return { consistency: consistency(scores), discrimination: discrimination(top, bottom) };
}
