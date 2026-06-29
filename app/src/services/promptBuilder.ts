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
  '- When it helps the user reply quickly, offer concrete example answers in "suggestions".',
  '- Keep the interview short — at most about 5 rounds, and prefer fewer. As soon as you can write a strong prompt, or the user asks you to generate, output the final system prompt and make reasonable assumptions for anything still unspecified.',
  '',
  'Respond with exactly one of these JSON shapes:',
  '- To ask: {"kind":"question","message":string,"suggestions":string[]}',
  '- To deliver: {"kind":"prompt","systemPrompt":string,"summary":string}',
  '',
  'The systemPrompt must be a complete, ready-to-use system prompt addressed to the model in the second person, with a clear role, behavior, output contract, and guardrails. The summary is one sentence on what you built and any assumptions you made.',
].join('\n');

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
