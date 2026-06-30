/**
 * Fix-suggestion service (PRD §8.4, post-run). Turns failing case results into a
 * ranked list of concrete prompt edits, each tied to the case that exposed it.
 */
import type { CaseResult, EvalCase } from '../shared/types';
import type { ChatMessage, Provider } from '../providers/types';
import type { Clock } from '../core/stream';
import type { FetchLike } from '../providers/types';
import { FixesSchema } from '../shared/schema';
import { failingFirst, DEFAULT_PASS_THRESHOLD } from '../core/results';
import { callJson } from './jsonCall';
import { chatOptions } from './opts';
import type { z } from 'zod';

export type Fix = z.infer<typeof FixesSchema>['fixes'][number];

export interface FixDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly passThreshold?: number;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

interface FailureContext {
  readonly caseId: string;
  readonly input: string;
  readonly output: string;
  readonly rationale: string;
}

/** Pair failing results with their case inputs, worst first. Pure + testable. */
export function collectFailures(
  cases: readonly EvalCase[],
  results: readonly CaseResult[],
  threshold = DEFAULT_PASS_THRESHOLD,
): FailureContext[] {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  // Single authority: the per-case `passed` flag. `failingFirst` orders by the
  // same flag, so ordering and filtering can never disagree.
  return failingFirst(results, threshold)
    .filter((r) => !r.passed)
    .map((r) => ({
      caseId: r.caseId,
      input: caseById.get(r.caseId)?.input ?? '',
      output: r.output,
      rationale: r.rationale,
    }));
}

export function buildFixMessages(systemPrompt: string, failures: readonly FailureContext[]): ChatMessage[] {
  const instruction = [
    'You are litmus, a prompt-improvement assistant.',
    'Given a system prompt and the cases where its outputs failed, propose concrete, applyable edits',
    'to the system prompt, ranked by impact. Each fix names the case it addresses.',
    'Respond with ONLY JSON, no prose and no code fences:',
    '{"fixes":[{"title":string,"edit":string,"caseRef":string?}]}',
  ].join('\n');

  const body = [
    `SYSTEM PROMPT:\n${systemPrompt}`,
    'FAILURES:',
    ...failures.map((f, i) => `#${i + 1} [${f.caseId}] input="${f.input}" why_failed="${f.rationale}"`),
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: body },
  ];
}

export function parseFixes(text: string): Fix[] {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const json: unknown = JSON.parse(cleaned);
  return FixesSchema.parse(json).fixes;
}

export async function suggestFixes(
  systemPrompt: string,
  cases: readonly EvalCase[],
  results: readonly CaseResult[],
  deps: FixDeps,
): Promise<Fix[]> {
  const failures = collectFailures(cases, results, deps.passThreshold ?? DEFAULT_PASS_THRESHOLD);
  if (failures.length === 0) return [];
  return callJson(
    deps.provider,
    { model: deps.model, messages: buildFixMessages(systemPrompt, failures), temperature: 0.2 },
    chatOptions(deps),
    parseFixes,
  );
}
