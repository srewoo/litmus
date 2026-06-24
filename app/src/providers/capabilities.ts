/**
 * Per-model capability quirks. Reasoning models (OpenAI o-series, reasoning
 * variants) reject the `temperature` parameter, so we omit it for them. We also
 * filter a raw model list down to chat-capable models (a /v1/models list includes
 * embeddings, TTS, image, etc. that 400 on chat completions).
 */
import type { ProviderId } from '../shared/types';

/**
 * Whether to send `temperature` for this model. OpenAI's GPT-5 family and
 * o-series reasoning models only accept the default (1) and 400 on a custom
 * value, so we allowlist the families known to accept it and omit otherwise.
 */
export function supportsTemperature(provider: ProviderId, model: string): boolean {
  if (provider === 'openai') return /^(gpt-4|gpt-3\.5|chatgpt-4)/i.test(model);
  return true;
}

const OPENAI_NON_CHAT = /(embedding|whisper|tts|audio|dall-?e|image|moderation|realtime|transcribe|search|babbage|davinci)/i;

/** Whether a listed model is usable via chat completions (filters out non-chat OpenAI models). */
export function isChatModel(provider: ProviderId, model: string): boolean {
  if (provider === 'openai') return !OPENAI_NON_CHAT.test(model);
  return true;
}
