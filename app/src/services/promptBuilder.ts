/**
 * Prompt builder service: an interactive system-prompt generator. The user
 * describes what they want; the model runs a short interview — asking focused
 * clarifying questions a round at a time — then emits a complete, ready-to-use
 * system prompt. The provider is injected (testable without network) and every
 * turn is Zod-validated before the UI touches it. The generated prompt flows
 * straight into the existing test pipeline (Capture → Analyze → Run).
 */
import type { PromptBuilderTurn } from '../shared/types';
import type { ChatMessage, Provider } from '../providers/types';
import type { Clock } from '../core/stream';
import type { FetchLike } from '../providers/types';
import { PromptBuilderTurnSchema } from '../shared/schema';
import { callJson } from './jsonCall';
import { chatOptions } from './opts';

export interface BuilderDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  /** Model that runs the interview and writes the prompt. */
  readonly model: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

/** The system instruction that turns the model into litmus's prompt architect. */
export const BUILDER_SYSTEM = [
  "You are litmus's prompt architect. You help the user create a high-quality SYSTEM PROMPT for an LLM through a short, focused interview.",
  '',
  'Rules:',
  '- Work one turn at a time. Respond with ONLY JSON — no prose, no markdown fences.',
  '- If you still need information to write a strong prompt, ask ONE round of clarifying questions (bundle 1-3 tightly related questions into a single message). Cover the essentials first: the assistant\'s role and goal, the audience, the expected output format/structure, tone, hard constraints and guardrails, and any tools or knowledge it relies on. Never ask about something the user already told you.',
  '- When it helps the user reply quickly, offer up to 3 concrete example answers in "suggestions". Keep each SHORT — a phrase or a single sentence the user could tap to answer — never multiple sentences or paragraphs packed into one suggestion.',
  '- Keep the interview short — at most about 5 rounds, and prefer fewer. As soon as you can write a strong prompt, or the user asks you to generate, output the final system prompt and make reasonable assumptions for anything still unspecified.',
  '',
  'Respond with exactly one of these JSON shapes:',
  '- To ask: {"kind":"question","message":string,"suggestions":string[]}',
  '- To deliver: {"kind":"prompt","systemPrompt":string,"summary":string}',
  '',
  'The systemPrompt must be a complete, ready-to-use system prompt, addressed to the model in the second person. It MUST cover, in this order, whether or not the user asked: (1) ROLE — one line on who the model is and its goal; (2) BEHAVIOR — how it should approach the task; (3) OUTPUT CONTRACT — the exact required output shape (for structured tasks, give an explicit schema or format, not a vague description); (4) GUARDRAILS — what it must never do, and how to handle out-of-scope or ambiguous input. Prefer specific, testable instructions over generic advice; do not pad.',
  'The summary is one sentence naming what you built AND, explicitly, any assumptions you made for unspecified details (so the user can correct them).',
  '',
  'Example of the delivery shape (structure and specificity to match; adapt the content to the user\'s task):',
  '{"kind":"prompt","systemPrompt":"You are a support-ticket triage assistant for a B2B SaaS help desk. Your goal is to classify each incoming ticket and extract routing fields.\\n\\nBehavior: Read the ticket, decide the single best category, and pull the requested fields. If information is missing, use null — never guess.\\n\\nOutput contract: Return ONLY valid JSON: {\\"category\\": one of [\\"billing\\",\\"bug\\",\\"how-to\\",\\"feature-request\\"], \\"priority\\": one of [\\"low\\",\\"medium\\",\\"high\\"], \\"summary\\": string (<=20 words)}. No prose outside the JSON.\\n\\nGuardrails: Never invent a category outside the list. Never include PII in the summary. If the ticket is empty or unintelligible, return category \\"how-to\\" with priority \\"low\\" and summary \\"unclear request\\".","summary":"Built a JSON-only ticket-triage classifier; assumed a fixed 4-category taxonomy and low/medium/high priority since you didn\'t specify."}',
].join('\n');

/**
 * Canned refinement instructions for the result quick-actions. Each is appended as
 * a user turn and then generation is forced, so the model rewrites the current
 * prompt along one axis without re-interviewing.
 */
export const REFINEMENTS: Record<'regenerate' | 'stricter' | 'shorter' | 'json', string> = {
  regenerate: 'Regenerate the system prompt with a fresh take on the same requirements — different structure or wording, same intent.',
  stricter: 'Rewrite the system prompt to be stricter: tighten the guardrails, remove ambiguity, and make constraints explicit and testable.',
  shorter: 'Rewrite the system prompt to be more concise — keep every essential instruction and the output contract, cut padding and repetition.',
  json: 'Rewrite the system prompt so the model must return strict, valid JSON, with an explicit schema (field names, types, and allowed values) in the output contract.',
};

/** Nudge appended when the user forces generation before the interview converges. */
const FORCE_GENERATE =
  'Generate the final system prompt now from everything gathered so far. Make reasonable assumptions for anything unspecified. Respond with the {"kind":"prompt",...} shape.';

/**
 * Assemble the interview messages: the architect system prompt, the running
 * conversation, and (when forced) a final instruction to generate now. Pure, so
 * the prompt is testable.
 */
export function buildBuilderMessages(conversation: readonly ChatMessage[], forceGenerate = false): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: BUILDER_SYSTEM }, ...conversation];
  if (forceGenerate) messages.push({ role: 'user', content: FORCE_GENERATE });
  return messages;
}

/** Parse and validate one builder turn. Tolerates accidental code fences. */
export function parseBuilderTurn(text: string): PromptBuilderTurn {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const json: unknown = JSON.parse(cleaned);
  return PromptBuilderTurnSchema.parse(json);
}

/** Run one interview turn against the injected provider. */
export async function builderTurn(
  conversation: readonly ChatMessage[],
  deps: BuilderDeps,
  forceGenerate = false,
): Promise<PromptBuilderTurn> {
  const messages = buildBuilderMessages(conversation, forceGenerate);
  // A touch of temperature for varied, natural questioning; deterministic when forced.
  const temperature = forceGenerate ? 0 : 0.4;
  return callJson(deps.provider, { model: deps.model, messages, temperature }, chatOptions(deps), parseBuilderTurn);
}
