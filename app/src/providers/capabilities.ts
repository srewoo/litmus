/**
 * Per-model capability quirks. The posture here is FAIL-OPEN: unknown or newer
 * model ids (including BYOK custom / fine-tuned ids the patterns never
 * anticipated) are assumed capable, and we only deny the families *known* to be
 * incapable via per-provider denylists. This lets the provider surface a real
 * 400 for a genuinely-unsupported id rather than pre-emptively refusing a model
 * that actually works. Reasoning models (OpenAI o-series, GPT-5 family) reject a
 * custom `temperature`, so we omit it for them. We also filter a raw model list
 * down to chat-capable models (a /v1/models list includes embeddings, TTS,
 * image, etc. that 400 on chat completions).
 */
import type { ProviderId } from '../shared/types';

/**
 * Whether to send `temperature` for this model. Fail-open: send temperature by
 * default, including for unknown / newer ids and fine-tune ids (`ft:gpt-4o:...`).
 * Only OMIT it for the OpenAI families known to reject a custom value — the
 * o-series and the gpt-5 reasoning families, which only accept the default (1)
 * and 400 otherwise.
 */
const OPENAI_NO_TEMPERATURE = /^(o\d|gpt-5)/i;

export function supportsTemperature(provider: ProviderId, model: string): boolean {
  if (provider === 'openai') return !OPENAI_NO_TEMPERATURE.test(model);
  return true;
}

/**
 * OpenAI reasoning families (o-series, gpt-5) reject the legacy `max_tokens`
 * field and require `max_completion_tokens` instead — the same families that
 * reject a custom `temperature`. Kept as a SEPARATE predicate/regex from
 * temperature handling so the two can diverge independently as the API evolves.
 */
const OPENAI_MAX_COMPLETION_TOKENS = /^(o\d|gpt-5)/i;

/**
 * The request field an OpenAI-shaped API expects for the output-token limit.
 * Fail-open: default to the widely-accepted `max_tokens`, and only switch to
 * `max_completion_tokens` for the OpenAI reasoning families known to reject
 * `max_tokens` with a 400.
 */
export function maxTokensField(provider: ProviderId, model: string): 'max_tokens' | 'max_completion_tokens' {
  if (provider === 'openai' && OPENAI_MAX_COMPLETION_TOKENS.test(model)) return 'max_completion_tokens';
  return 'max_tokens';
}

// `search(?!-preview)` filters embeddings/search helper ids while letting the
// real chat-completions models `gpt-4o-search-preview` / `gpt-4o-mini-search-preview`
// through (their token is `search-preview`, not a bare `search`).
const OPENAI_NON_CHAT = /(embedding|whisper|tts|audio|dall-?e|image|moderation|realtime|transcribe|search(?!-preview)|babbage|davinci)/i;

/** Whether a listed model is usable via chat completions (filters out non-chat OpenAI models). */
export function isChatModel(provider: ProviderId, model: string): boolean {
  if (provider === 'openai') return !OPENAI_NON_CHAT.test(model);
  return true;
}

/**
 * Whether a model accepts the `tools` / function-calling parameter. Fail-open:
 * assume capable by default — including unknown / newer ids and BYOK custom /
 * fine-tuned ids — and only deny the families *known* not to support tools, so a
 * genuinely-unsupported id surfaces a real provider 400 rather than being
 * refused pre-emptively. Known-incapable denylists:
 *  - OpenAI: non-chat models (embeddings, TTS, whisper, ...) and the legacy
 *    gpt-3.5 base / -instruct models (only gpt-3.5-turbo supports tools).
 *  - Anthropic: claude-2 / claude-instant predate tool use.
 *  - Google: gemini-1.0 and pro-vision predate function calling.
 */
export function supportsTools(provider: ProviderId, model: string): boolean {
  if (provider === 'openai') {
    if (!isChatModel('openai', model)) return false;
    // gpt-3.5-turbo supports tools, but the legacy gpt-3.5 base/instruct models do
    // not — gpt-3.5-turbo-instruct is a completions-only model with no function calling.
    if (/^gpt-3\.5/i.test(model)) return /^gpt-3\.5-turbo/i.test(model) && !/-instruct/i.test(model);
    return true;
  }
  if (provider === 'anthropic') {
    // Tool use shipped with claude-3; claude-2 / claude-instant predate it.
    if (/claude-(2|instant)/i.test(model)) return false;
    return true;
  }
  if (provider === 'google') {
    // gemini-1.5 and the 2.x+ families support function calling; gemini-1.0/pro-vision do not.
    if (/gemini-1\.0|pro-vision/i.test(model)) return false;
    return true;
  }
  // Unknown / BYOK provider: assume capable and let the provider reject it.
  return true;
}
