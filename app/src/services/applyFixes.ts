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
import type { TargetModel, EvalCase, CaseResult } from '../shared/types';

export interface ApplyFixDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly target?: TargetModel;
  readonly cases?: readonly EvalCase[];
  readonly results?: readonly CaseResult[];
  readonly passThreshold?: number;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

/** Extract double-curly placeholders from prompt text. */
export function extractPlaceholders(text: string): string[] {
  const matches = text.match(/\{\{[^{}]+\}\}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

/** Check if any placeholders from original are missing in revised. */
export function checkPlaceholders(original: string, revised: string): string[] {
  const origPlaceholders = extractPlaceholders(original);
  const revisedPlaceholders = new Set(extractPlaceholders(revised));
  return origPlaceholders.filter((p) => !revisedPlaceholders.has(p));
}

export function buildApplyMessages(
  systemPrompt: string,
  fixes: readonly Fix[],
  target?: TargetModel,
  cases?: readonly EvalCase[],
  results?: readonly CaseResult[],
  passThreshold?: number,
): ChatMessage[] {
  const instruction = [
    'You are litmus, a prompt editor.',
    'Rewrite the SYSTEM PROMPT below so it incorporates EVERY fix listed, preserving the',
    "original intent, voice, and any instructions that already work. Apply each edit precisely;",
    'do not add commentary, headings, rationale, or anything that is not part of the prompt itself.',
    'Output ONLY the revised system prompt text — no preamble, no markdown fences.',
  ];

  if (target) {
    instruction.push('');
    instruction.push(`CRITICAL TARGET MODEL INSTRUCTIONS (since the target model is ${target.provider}/${target.model}):`);
    if (target.provider === 'anthropic') {
      instruction.push('- Use structured XML tags (e.g. <instructions>, <context>, <examples>, <output_format>) to cleanly separate logical sections of the prompt.');
    } else if (target.provider === 'google') {
      instruction.push('- Use clean markdown headings, bullet points, and a structured layout (e.g. following the CO-STAR format: Context, Objective, Style, Tone, Audience, Response where applicable).');
    } else if (target.provider === 'openai') {
      instruction.push('- Prioritize explicit, concise instructions, clear rules/constraints, and direct response specifications.');
    }
  } else {
    instruction.push('');
    instruction.push('- Restructure the system prompt to follow a clear, professional layout (e.g. following the CO-STAR structure: Context, Objective, Style, Tone, Audience, Response where applicable).');
  }

  instruction.push('');
  instruction.push('CRITICAL PLACEHOLDER GUARDRAIL: You MUST preserve all variables, placeholders, or template tags (e.g. {{user_query}}, {{doc_text}}, or any double curly brace variables like {{...}}) that exist in the original system prompt. Do not delete, rename, or modify them under any circumstance.');
  instruction.push('CRITICAL SCHEMA GUARDRAIL: Do NOT modify any existing JSON schema definitions, response contracts, format examples, or structured data shapes in the prompt unless one of the fixes explicitly asks to change the format/schema.');

  const body = [
    `SYSTEM PROMPT:\n${systemPrompt}`,
    '',
    'FIXES TO APPLY:',
    ...fixes.map((f, i) => `${i + 1}. ${f.title}: ${f.edit}${f.caseRef ? ` (from ${f.caseRef})` : ''}`),
  ];

  if (cases && results) {
    const threshold = passThreshold ?? 6;
    const positive: Array<{ input: string; output: string }> = [];
    const negative: Array<{ input: string; output: string; rationale: string }> = [];
    const caseMap = new Map(cases.map((c) => [c.id, c]));

    for (const r of results) {
      const c = caseMap.get(r.caseId);
      // Only harvest examples for text-only cases to keep formatting clean
      if (!c || c.toolExpectations || c.scenario || c.media) continue;
      if (r.passed && r.score >= threshold) {
        positive.push({ input: c.input, output: r.output });
      } else if (!r.passed) {
        negative.push({ input: c.input, output: r.output, rationale: r.rationale });
      }
    }

    if (positive.length > 0) {
      body.push('');
      body.push('SUCCESSFUL EXAMPLES (incorporate these as positive few-shot examples using the target format):');
      positive.slice(0, 3).forEach((p, idx) => {
        body.push(`Example #${idx + 1}:`);
        body.push(`Input: ${p.input}`);
        body.push(`Output: ${p.output}`);
        body.push('---');
      });
    }

    if (negative.length > 0) {
      body.push('');
      body.push('FAILED EXAMPLES (use these to write negative constraints/warnings or corrected example pairs):');
      negative.slice(0, 3).forEach((n, idx) => {
        body.push(`Failed Case #${idx + 1}:`);
        body.push(`Input: ${n.input}`);
        body.push(`Incorrect Output: ${n.output}`);
        body.push(`Failure Reason: ${n.rationale}`);
        body.push('---');
      });
    }
  }

  return [
    { role: 'system', content: instruction.join('\n') },
    { role: 'user', content: body.join('\n') },
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
    {
      model: deps.model,
      messages: buildApplyMessages(
        systemPrompt,
        fixes,
        deps.target,
        deps.cases,
        deps.results,
        deps.passThreshold,
      ),
      temperature: 0.2,
    },
    chatOptions(deps),
  );
  const revised = unfence(res.text) || systemPrompt;

  const missing = checkPlaceholders(systemPrompt, revised);
  if (missing.length > 0) {
    throw new Error(`Placeholder validation failed: the revised prompt is missing original variables: ${missing.join(', ')}`);
  }

  return revised;
}

