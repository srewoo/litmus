/**
 * Media-model capability classification (ADR 0007), a sibling of capabilities.ts.
 *
 * Given a model id, name the media kind it GENERATES, by known per-family
 * patterns. The posture matches ADR 0005: FAIL-OPEN. A recognized family returns
 * its kind; anything unrecognized returns 'unknown' — never a pre-emptive refusal,
 * so a brand-new or BYOK/custom media model works the day it exists and the
 * provider's own 400 stays the source of truth. The only use of a *known* answer
 * is a friendly pre-check: warn when the user pairs, say, an image model with the
 * document pack. 'unknown' never warns.
 *
 * Documents are typically produced by orchestrating a chat model + a renderer
 * rather than a dedicated "document model", so there is deliberately no document
 * pattern here — a chat id used for the document pack classifies as 'unknown'
 * (allowed), not 'none'.
 */
import type { ProviderId } from '../shared/types';
import type { MediaKind } from '../shared/media';

export type MediaCapability = MediaKind | 'unknown';

// Cross-provider generator families (2026-era). Order matters only in that the
// first match wins; the sets are disjoint in practice.
const IMAGE = /(gpt-image|dall-?e|imagen|stable-?diffusion|(^|[^a-z])sd(xl|\d)|flux|firefly|seedream|nano-banana|ideogram|recraft)/i;
const VIDEO = /(sora|veo|runway|gen-\d|kling|pika|luma|wan\d|seedance|ltx|mochi|hunyuan-?video)/i;
// TTS / audio GENERATION only. Whisper/transcribe are input-side (ASR), not
// generation, so they are intentionally NOT matched here.
const VOICE = /(tts|text-to-speech|\bspeech\b|eleven|playht|musicgen|audiogen|\bbark\b|suno|\bvoice\b)/i;

/** Classify a model id into the media kind it generates, or 'unknown' (fail-open). */
export function mediaCapability(_provider: ProviderId, model: string): MediaCapability {
  if (IMAGE.test(model)) return 'image';
  if (VIDEO.test(model)) return 'video';
  if (VOICE.test(model)) return 'voice';
  return 'unknown';
}

/**
 * True only when we KNOW the model generates a different media kind than the pack
 * asks for — the signal for a friendly pre-check. An 'unknown' capability (new /
 * custom id, or a chat model for the document pack) never reports a mismatch.
 */
export function mediaModelMismatch(provider: ProviderId, model: string, kind: MediaKind): boolean {
  const cap = mediaCapability(provider, model);
  return cap !== 'unknown' && cap !== kind;
}
