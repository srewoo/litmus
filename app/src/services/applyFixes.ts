/**
 * Apply-fixes service. Given a system prompt and the ranked fixes suggested from
 * its failing cases, rewrites the prompt so it incorporates every fix while
 * preserving the original intent and voice. Returns the revised prompt TEXT.
 * Provider injected, so this is testable without network.
 */
import type { ChatMessage, Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import type { Fix } from './fixes';
import { chatOptions } from './opts';

export interface ApplyFixDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export function buildApplyMessages(systemPrompt: string, fixes: readonly Fix[]): ChatMessage[] {
  const instruction = [
    'You are litmus, a prompt editor.',
    'Rewrite the SYSTEM PROMPT below so it incorporates EVERY fix listed, preserving the',
    "original intent, voice, and any instructions that already work. Apply each edit precisely;",
    'do not add commentary, headings, rationale, or anything that is not part of the prompt itself.',
    'Output ONLY the revised system prompt text — no preamble, no markdown fences.',
  ].join('\n');

  const body = [
    `SYSTEM PROMPT:\n${systemPrompt}`,
    '',
    'FIXES TO APPLY:',
    ...fixes.map((f, i) => `${i + 1}. ${f.title}: ${f.edit}${f.caseRef ? ` (from ${f.caseRef})` : ''}`),
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: body },
  ];
}

/**
 * Strip a code fence ONLY when it wraps the entire prompt (a leading ```lang
 * line and a trailing ``` line). Internal fenced code blocks — which can be a
 * legitimate part of a revised prompt — are left intact.
 */
function unfence(text: string): string {
  const trimmed = text.trim();
  const wrapped = /^```[a-z0-9-]*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return (wrapped ? wrapped[1]! : trimmed).trim();
}

/** Rewrite the prompt with the fixes applied. No-op (returns input) when fixes is empty. */
export async function applyFixes(
  systemPrompt: string,
  fixes: readonly Fix[],
  deps: ApplyFixDeps,
): Promise<string> {
  if (fixes.length === 0) return systemPrompt;
  const res = await deps.provider.chat(
    { model: deps.model, messages: buildApplyMessages(systemPrompt, fixes), temperature: 0.2 },
    chatOptions(deps),
  );
  return unfence(res.text) || systemPrompt;
}
