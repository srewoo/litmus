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

/**
 * Whether a model accepts the `tools` / function-calling parameter. Conservative
 * per current model families:
 *  - OpenAI: gpt-4 / gpt-4o / gpt-4.1 / o-series / gpt-5 all support tools, and
 *    gpt-3.5-turbo supports tools. Non-chat models (embeddings, TTS, ...) do not.
 *  - Anthropic: claude-3 and newer (claude-3, claude-3.5, claude-4, ...) support tools.
 *  - Google: gemini-1.5 and the 2.x line (and newer) support tools.
 */
export function supportsTools(provider: ProviderId, model: string): boolean {
  if (provider === 'openai') {
    if (!isChatModel('openai', model)) return false;
    // gpt-3.5-turbo supports tools, but the legacy gpt-3.5 base/instruct models do not.
    if (/^gpt-3\.5/i.test(model)) return /^gpt-3\.5-turbo/i.test(model);
    return /^(gpt-4|gpt-5|chatgpt-4|o\d)/i.test(model);
  }
  if (provider === 'anthropic') {
    // Tool use shipped with claude-3; claude-2 / claude-instant predate it.
    return /claude-(3|4|opus-4|sonnet-4|haiku-4|[5-9])/i.test(model);
  }
  if (provider === 'google') {
    // gemini-1.5 and the 2.x+ families support function calling; gemini-1.0/pro-vision do not.
    if (/gemini-1\.0/i.test(model)) return false;
    return /gemini-(1\.5|[2-9])/i.test(model);
  }
  return false;
}
