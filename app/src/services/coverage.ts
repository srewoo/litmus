/**
 * Coverage matrix. Extracts each instruction in the system prompt
 * and maps it to a dimension that tests it — or null (NOT TESTED) to expose gaps.
 */
import type { ChatMessage, Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import { CoverageSchema } from '../shared/schema';
import { callJson } from './jsonCall';
import { chatOptions } from './opts';
import type { z } from 'zod';

export type CoverageRow = z.infer<typeof CoverageSchema>['coverage'][number];

export interface CoverageDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export function buildCoverageMessages(systemPrompt: string, dimensionNames: readonly string[]): ChatMessage[] {
  const instruction = [
    'You are an evaluation auditor. Extract each distinct instruction/requirement from the system',
    'prompt below (what it MUST do, MUST NOT do, output format, procedure, edge cases).',
    `For each instruction, name which of these eval dimensions would TEST it: [${dimensionNames.join(', ')}].`,
    'If NO listed dimension tests it, set "dimension" to null (NOT TESTED).',
    'Respond with ONLY JSON, no prose or fences:',
    '{"coverage":[{"instruction":string,"dimension":string|null}]}',
  ].join('\n');
  return [
    { role: 'system', content: instruction },
    { role: 'user', content: systemPrompt },
  ];
}

export function parseCoverage(text: string): CoverageRow[] {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const json: unknown = JSON.parse(cleaned);
  return CoverageSchema.parse(json).coverage;
}

export async function analyzeCoverage(
  systemPrompt: string,
  dimensionNames: readonly string[],
  deps: CoverageDeps,
): Promise<CoverageRow[]> {
  return callJson(
    deps.provider,
    { model: deps.model, messages: buildCoverageMessages(systemPrompt, dimensionNames), temperature: 0 },
    chatOptions(deps),
    parseCoverage,
  );
}

/** Instructions with no testing dimension. */
export function coverageGaps(rows: readonly CoverageRow[]): CoverageRow[] {
  return rows.filter((r) => r.dimension === null);
}
