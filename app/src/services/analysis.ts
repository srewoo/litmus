/**
 * Prompt analysis service (PRD §8.3). Asks the analyzer model to score a system
 * prompt on language / intent / format / tone *for the chosen target model*, and
 * to propose concrete rewrites. The provider is injected, so this is testable
 * without network; the model's JSON output is Zod-validated before use.
 */
import type { PromptAnalysis, TargetModel } from '../shared/types';
import type { ChatMessage, Provider } from '../providers/types';
import type { Clock } from '../core/stream';
import type { FetchLike } from '../providers/types';
import { PromptAnalysisSchema } from '../shared/schema';
import { callJson } from './jsonCall';
import { chatOptions } from './opts';

export interface AnalyzeDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  /** Model that performs the analysis (may differ from the target under test). */
  readonly analyzerModel: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

/** Build the analysis chat messages. Pure, so the prompt itself is testable. */
export function buildAnalysisMessages(systemPrompt: string, target: TargetModel): ChatMessage[] {
  const instruction = [
    'You are litmus, a system-prompt analyst.',
    `Analyze the system prompt below as it will behave on ${target.provider}/${target.model}.`,
    'Score each facet 0-10 with a one-line finding:',
    '- language: clarity, ambiguity, contradictory or dead instructions',
    '- intent: is the goal stated explicitly, or must the model guess success?',
    '- format: is the output contract (schema/structure/length) pinned tightly?',
    '- tone: is the register appropriate and consistent for the task?',
    'Then list concrete, applyable rewrite suggestions.',
    'Respond with ONLY JSON, no prose and no code fences:',
    '{"facets":[{"facet":"language|intent|format|tone","score":number,"finding":string}],"suggestions":[string]}',
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: systemPrompt },
  ];
}

/** Parse and validate the model's analysis output. Tolerates accidental code fences. */
export function parseAnalysis(text: string): PromptAnalysis {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const json: unknown = JSON.parse(cleaned);
  return PromptAnalysisSchema.parse(json);
}

/** Run the analysis end to end against the injected provider. */
export async function analyzePrompt(
  systemPrompt: string,
  target: TargetModel,
  deps: AnalyzeDeps,
): Promise<PromptAnalysis> {
  const messages = buildAnalysisMessages(systemPrompt, target);
  return callJson(deps.provider, { model: deps.analyzerModel, messages, temperature: 0 }, chatOptions(deps), parseAnalysis);
}
