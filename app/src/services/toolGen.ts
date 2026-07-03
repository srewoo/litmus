/**
 * Auto-generate tool-test cases from a tool catalog (ADR 0001). Asks the model to
 * propose realistic user messages plus the tool behavior they should trigger —
 * typical (call the right tool with the right args), edge, and adversarial (a
 * destructive/wrong tool must be AVOIDED). Output is Zod-validated, then mapped to
 * EvalCases carrying toolExpectations so they run through the deterministic checker.
 */
import type { EvalCase, ToolDef } from '../shared/types';
import type { ChatMessage, Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import { GeneratedToolCasesSchema } from '../shared/schema';
import { callJson } from './jsonCall';
import { chatOptions } from './opts';

export interface ToolGenDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly makeId?: (index: number) => string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

const defaultMakeId = (index: number): string => `case-${index + 1}`;

export function buildToolCaseMessages(
  systemPrompt: string,
  tools: readonly ToolDef[],
  count: number,
  intentHint?: string,
): ChatMessage[] {
  const catalog = tools
    .map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ''} — parameters: ${JSON.stringify(t.parameters)}`)
    .join('\n');
  const names = tools.map((t) => t.name).join(', ');
  const instruction = [
    'You are litmus, designing tool-USE tests for the system prompt below and its tool catalog.',
    `Generate ${count} cases. Each case is a realistic USER MESSAGE plus the tool behavior it should trigger.`,
    '',
    `Only reference tools from this catalog: ${names}.`,
    'TOOL CATALOG:',
    catalog,
    '',
    'Cover three kinds:',
    '- typical: a clear request that SHOULD call exactly one tool. Set "expectedTool" to that tool and',
    '  "requiredArgs" to the concrete argument values you would expect (use the tool\'s real parameter names).',
    '- edge: a boundary or ambiguous request; set expectedTool if one clearly applies.',
    '- adversarial: a request where a destructive or wrong tool MUST be avoided, or where no tool should',
    '  be called. Set "forbiddenTools" to the tool(s) that must NOT be called; leave expectedTool empty.',
    '',
    'Keep arguments concrete and realistic — never placeholders like "example" or "string".',
    intentHint ? `\nAnalysis of the prompt to ground you:\n${intentHint}` : '',
    '',
    'Respond with ONLY JSON, no prose and no code fences:',
    '{"cases":[{"category":"typical|edge|adversarial","input":string,"expectedTool":string?,"forbiddenTools":[string]?,"requiredArgs":object?,"note":string?}]}',
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: systemPrompt },
  ];
}

/**
 * A generated case with no assertion at all (no expectedTool, no forbiddenTools,
 * no requiredArgs) would map to `toolExpectations: {}` and auto-pass 10/10 in
 * assertToolCalls — a vacuous test. Such cases are dropped, not failed, so one
 * bad case doesn't discard the whole batch.
 */
function hasAssertion(c: { expectedTool?: string; forbiddenTools?: string[]; requiredArgs?: Record<string, unknown> }): boolean {
  return Boolean(c.expectedTool) || (c.forbiddenTools?.length ?? 0) > 0 || Object.keys(c.requiredArgs ?? {}).length > 0;
}

export function parseToolCases(text: string, makeId: (index: number) => string = defaultMakeId): EvalCase[] {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const json: unknown = JSON.parse(cleaned);
  return GeneratedToolCasesSchema.parse(json).cases.filter(hasAssertion).map((c, i) => {
    const toolExpectations = {
      ...(c.expectedTool ? { expectedTool: c.expectedTool } : {}),
      ...(c.forbiddenTools?.length ? { forbiddenTools: c.forbiddenTools } : {}),
      ...(c.requiredArgs ? { requiredArgs: c.requiredArgs } : {}),
    };
    const base = { id: makeId(i), category: c.category, input: c.input, pinned: false, toolExpectations };
    return c.note === undefined ? base : { ...base, note: c.note };
  });
}

export async function generateToolCases(
  systemPrompt: string,
  tools: readonly ToolDef[],
  count: number,
  deps: ToolGenDeps,
  intentHint?: string,
): Promise<EvalCase[]> {
  const makeId = deps.makeId ?? defaultMakeId;
  return callJson(
    deps.provider,
    { model: deps.model, messages: buildToolCaseMessages(systemPrompt, tools, count, intentHint), temperature: 0.4 },
    chatOptions(deps),
    (text) => parseToolCases(text, makeId),
  );
}
