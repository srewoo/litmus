/**
 * Dimension extraction. Reads the system prompt and selects the
 * quality dimensions its OUTPUT should be judged on, scaled to the prompt's
 * complexity (simple → 2–3, complex → 5–7). One eval prompt is then generated per
 * dimension. Provider injected; output Zod-validated.
 */
import type { ChatMessage, Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import { DimensionsSchema } from '../shared/schema';
import { callJson } from './jsonCall';
import { chatOptions } from './opts';
import type { z } from 'zod';

export type Dimension = z.infer<typeof DimensionsSchema>['dimensions'][number];

export interface ExtractDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export function buildDimensionMessages(systemPrompt: string, analysisHint?: string): ChatMessage[] {
  const instruction = [
    'You are an evaluation architect. Identify the distinct quality DIMENSIONS that the OUTPUT of the',
    'system prompt below should be judged on. Scale the count to the prompt\'s complexity:',
    'a simple prompt needs 2–3 dimensions; a rich/multi-rule prompt needs 5–7. Never more than 8.',
    '',
    'Draw from this taxonomy (use only what applies, name them in snake_case):',
    '- format_compliance, instruction_adherence, completeness (almost always relevant)',
    '- groundedness, coherence, reasoning_rigor (if the output contains claims/reasoning)',
    '- framework_alignment, attribution_accuracy, communicability (if a domain/framework is specified)',
    '- safety_compliance, hallucination_resistance, calibration (if safety-critical)',
    'Prefer dimensions specific to THIS prompt over generic ones. Each must be independently testable',
    '(no two dimensions measuring the same thing).',
    '',
    'For each: a snake_case "name" and a one-line "description" of what it checks.',
    analysisHint ? `\nAnalysis to ground you:\n${analysisHint}` : '',
    '',
    'Respond with ONLY JSON, no prose or fences:',
    '{"dimensions":[{"name":string,"description":string}]}',
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: systemPrompt },
  ];
}

export function parseDimensions(text: string): Dimension[] {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const json: unknown = JSON.parse(cleaned);
  return DimensionsSchema.parse(json).dimensions;
}

export async function extractDimensions(
  systemPrompt: string,
  deps: ExtractDeps,
  analysisHint?: string,
): Promise<Dimension[]> {
  return callJson(
    deps.provider,
    { model: deps.model, messages: buildDimensionMessages(systemPrompt, analysisHint), temperature: 0.2 },
    chatOptions(deps),
    parseDimensions,
  );
}
