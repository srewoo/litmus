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
import type { z } from 'zod';

export type Verdict = z.infer<typeof VerdictSchema>;

export interface JudgeDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  /** Optional generated eval-prompt rubric to score against (PRD §8.7). */
  readonly rubric?: string;
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

export async function judgeOutput(
  systemPrompt: string,
  caseInput: string,
  output: string,
  deps: JudgeDeps,
): Promise<Verdict> {
  return callJson(
    deps.provider,
    { model: deps.model, messages: buildJudgeMessages(systemPrompt, caseInput, output, deps.rubric), temperature: 0 },
    chatOptions(deps),
    parseVerdict,
  );
}
