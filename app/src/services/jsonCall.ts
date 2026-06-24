/**
 * Call a model expecting JSON, with one retry on parse failure. Real models
 * occasionally wrap JSON in prose or fences; on a parse miss we re-ask with an
 * explicit corrective nudge before giving up. Provider injected → testable.
 */
import type { ChatCallOptions, ChatRequest, Provider } from '../providers/types';

const NUDGE =
  'Your previous response could not be parsed. Reply with ONLY valid JSON matching the requested schema — no prose, no markdown fences.';

export async function callJson<T>(
  provider: Provider,
  request: ChatRequest,
  options: ChatCallOptions,
  parse: (text: string) => T,
  retries = 1,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const req: ChatRequest =
      attempt === 0
        ? request
        : { ...request, messages: [...request.messages, { role: 'user', content: NUDGE }] };
    const res = await provider.chat(req, options);
    try {
      return parse(res.text);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('callJson: parse failed after retries');
}
