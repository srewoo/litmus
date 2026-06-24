/**
 * Eval-case generation service (PRD §8.5). Generates typical / edge / adversarial
 * cases from a system prompt. Provider injected; model output Zod-validated.
 */
import type { EvalCase, TargetModel } from '../shared/types';
import type { ChatMessage, Provider } from '../providers/types';
import type { Clock } from '../core/stream';
import type { FetchLike } from '../providers/types';
import { GeneratedCasesSchema } from '../shared/schema';
import { callJson } from './jsonCall';
import { chatOptions } from './opts';

export interface GenerateDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly makeId?: (index: number) => string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

const defaultMakeId = (index: number): string => `case-${index + 1}`;

export function buildEvalMessages(systemPrompt: string, count: number, intentHint?: string): ChatMessage[] {
  const instruction = [
    'You are litmus, an evaluation designer.',
    `Generate ${count} evaluation cases for the SYSTEM PROMPT below.`,
    '',
    'CRITICAL — match the prompt\'s real input contract:',
    '1. First determine exactly what INPUT this prompt consumes: the variables, placeholders',
    '   (e.g. {{user_query}}, {{generated_answer}}), or named fields it references.',
    '2. If the prompt is itself an evaluator/judge that scores structured inputs, each case MUST',
    '   provide those exact fields (e.g. a user_query AND a generated_answer) — NOT a generic chat message.',
    '3. Each case is a concrete, COMPLETE instance of that input, filling every field the prompt expects.',
    '   Put it in "input" as one string; if there are multiple fields, label them, e.g.',
    '   "user_query: ...\\ngenerated_answer: ...".',
    '4. Do NOT invent a different task than the prompt describes.',
    '',
    'Cover three categories:',
    '- typical: normal, in-distribution inputs',
    '- edge: boundary or unusual-but-valid inputs',
    '- adversarial: inputs that probe the prompt\'s gaps, ambiguities, or guardrails',
    intentHint ? `\nAnalysis of the prompt to ground you:\n${intentHint}` : '',
    '',
    'Respond with ONLY JSON, no prose and no code fences:',
    '{"cases":[{"category":"typical|edge|adversarial","input":string,"note":string?}]}',
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: systemPrompt },
  ];
}

export function parseCases(text: string, makeId: (index: number) => string = defaultMakeId): EvalCase[] {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const json: unknown = JSON.parse(cleaned);
  const parsed = GeneratedCasesSchema.parse(json);
  return parsed.cases.map((c, i) => {
    const base = { id: makeId(i), category: c.category, input: c.input, pinned: false };
    return c.note === undefined ? base : { ...base, note: c.note };
  });
}

export async function generateCases(
  systemPrompt: string,
  _target: TargetModel,
  count: number,
  deps: GenerateDeps,
  intentHint?: string,
): Promise<EvalCase[]> {
  const makeId = deps.makeId ?? defaultMakeId;
  return callJson(
    deps.provider,
    { model: deps.model, messages: buildEvalMessages(systemPrompt, count, intentHint), temperature: 0.4 },
    chatOptions(deps),
    (text) => parseCases(text, makeId),
  );
}
