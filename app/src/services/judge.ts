/**
 * LLM-as-judge service (PRD §8.7). Scores one model output against the prompt's
 * intent, 0–10, with a rationale and optional per-dimension breakdown. The judge
 * model should differ from the target to reduce self-preference bias.
 */
import type { ChatMessage, Provider } from '../providers/types';
import type { Clock } from '../core/stream';
import type { FetchLike } from '../providers/types';
import { VerdictSchema } from '../shared/schema';
import { callJson } from './jsonCall';
import { chatOptions } from './opts';
import { aggregateVerdicts } from '../core/judgeAggregate';
import type { AggregatedVerdict } from '../core/judgeAggregate';
import { mapWithConcurrency } from '../shared/concurrency';
import { positiveCount } from '../shared/num';
import type { z } from 'zod';

export type Verdict = z.infer<typeof VerdictSchema>;

/** How many judge calls to run concurrently in an ensemble — keeps providers happy. */
const JUDGE_ENSEMBLE_CONCURRENCY = 3;
/**
 * When sampling the judge more than once, use a small non-zero temperature so the
 * samples actually vary — at temp 0 every call would be (near) identical and the
 * ensemble would measure nothing. A single judge call still uses temp 0.
 */
const DEFAULT_ENSEMBLE_TEMPERATURE = 0.4;

export interface JudgeDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  /** Optional generated eval-prompt rubric to score against (PRD §8.7). */
  readonly rubric?: string;
  /**
   * Run the judge this many times on the SAME output and fold to the MEDIAN, to
   * cut single-call judge noise (default 1 = one call, no ensemble).
   */
  readonly judgeSamples?: number;
  /** Sampling temperature for an ensemble; ignored for a single call. */
  readonly judgeTemperature?: number;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export function buildJudgeMessages(
  systemPrompt: string,
  caseInput: string,
  output: string,
  rubric?: string,
): ChatMessage[] {
  const base = rubric
    ? [
        'You are litmus, an impartial output judge. Apply the EVALUATION RUBRIC below to score the',
        'model output. Follow its sub-criteria, fail-safe logic, and evidence standards, then map the',
        'rubric verdict onto a single 0-10 score (FAIL≈0-3, WEAK≈4-5, ACCEPTABLE≈6-7, STRONG≈8-10).',
        '',
        'EVALUATION RUBRIC:',
        rubric,
        '',
        'Respond with ONLY JSON, no prose and no code fences:',
        '{"score":number,"rationale":string,"dimensions":[{"dimension":string,"score":number}]?}',
      ]
    : [
        'You are litmus, an impartial output judge.',
        'Given a system prompt, a user input, and the model output it produced, score the output 0-10',
        'for how well it satisfies the system prompt: task success, output-contract adherence,',
        'constraint adherence, and overall quality. Be strict; reserve 9-10 for excellent outputs.',
        'Respond with ONLY JSON, no prose and no code fences:',
        '{"score":number,"rationale":string,"dimensions":[{"dimension":string,"score":number}]?}',
      ];
  const instruction = base.join('\n');

  const payload = [
    `SYSTEM PROMPT:\n${systemPrompt}`,
    `USER INPUT:\n${caseInput}`,
    `MODEL OUTPUT:\n${output}`,
  ].join('\n\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: payload },
  ];
}

export function parseVerdict(text: string): Verdict {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const json: unknown = JSON.parse(cleaned);
  return VerdictSchema.parse(json);
}

/** One judge call at a given temperature. */
function judgeOnce(
  systemPrompt: string,
  caseInput: string,
  output: string,
  deps: JudgeDeps,
  temperature: number,
): Promise<Verdict> {
  return callJson(
    deps.provider,
    { model: deps.model, messages: buildJudgeMessages(systemPrompt, caseInput, output, deps.rubric), temperature },
    chatOptions(deps),
    parseVerdict,
  );
}

export async function judgeOutput(
  systemPrompt: string,
  caseInput: string,
  output: string,
  deps: JudgeDeps,
): Promise<Verdict> {
  return judgeOnce(systemPrompt, caseInput, output, deps, 0);
}

/**
 * Judge an output with self-consistency: run `judgeSamples` independent judge
 * calls (concurrently, bounded) and fold to a median verdict whose rationale
 * carries the panel's spread. `judgeSamples <= 1` is a single temp-0 call — the
 * exact previous behaviour, so callers opt in to the cost of an ensemble.
 */
export async function judgeOutputEnsemble(
  systemPrompt: string,
  caseInput: string,
  output: string,
  deps: JudgeDeps,
): Promise<AggregatedVerdict> {
  // `positiveCount` collapses a non-finite sample count to 1, so the ensemble
  // path never hits `Array.from({ length: NaN/Infinity })` (a RangeError / empty
  // panel that would throw in aggregateVerdicts).
  const samples = positiveCount(deps.judgeSamples ?? 1);
  if (samples === 1) return aggregateVerdicts([await judgeOutput(systemPrompt, caseInput, output, deps)]);

  const temperature = deps.judgeTemperature ?? DEFAULT_ENSEMBLE_TEMPERATURE;
  const verdicts = await mapWithConcurrency(
    Array.from({ length: samples }, (_, i) => i),
    JUDGE_ENSEMBLE_CONCURRENCY,
    () => judgeOnce(systemPrompt, caseInput, output, deps, temperature),
  );
  return aggregateVerdicts(verdicts);
}
