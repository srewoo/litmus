/**
 * Build the provider wiring for a run from settings + target.
 *
 * The judge defaults to the SAME model as the target — guaranteed callable if the
 * target is (avoids 404s from a model the user's key can't access). A distinct
 * judge can be set explicitly in settings (PRD §8.7 self-preference note).
 */
import type { Settings } from '../shared/schema';
import type { ProviderId, TargetModel } from '../shared/types';
import type { Provider } from '../providers/types';
import { isChatModel } from '../providers/capabilities';
import { mediaCapability } from '../providers/mediaCapability';

export interface LoopWiring {
  readonly targetProvider: Provider;
  readonly targetKey: string;
  readonly judgeProvider: Provider;
  readonly judgeKey: string;
  readonly auxModel: string;
}

/**
 * Resolve the judge/aux model: an explicit override, else the target model.
 * Strips any leading "provider/" (legacy stored values), and falls back to the
 * target model if the override isn't among the target provider's known models
 * (auto-heals a stale or cross-provider override).
 */
export function resolveJudgeModel(settings: Settings, target: TargetModel): string {
  const raw = settings.judgeModel?.trim();
  if (!raw) return target.model;
  const id = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
  if (!id) return target.model;
  const known = settings.availableModels?.[target.provider];
  if (known && known.length > 0 && !known.includes(id)) return target.model;
  return id;
}

/** Strip a legacy "provider/" prefix from a stored model id. */
function bareId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
}

/**
 * Resolve the OpenAI vision chat model for the image describer (ADR 0007).
 *
 * The image pack's TARGET is an image generator (gpt-image-1) that can't take
 * image INPUT, so content description (labels/OCR) needs a separate vision chat
 * model. Rather than hardcode one, use the model the USER already selected and has
 * access to: their explicit judge model, else their default target, else any
 * OpenAI chat model discovered from their key. A "vision chat model" here is an
 * OpenAI chat model that is NOT itself a media generator (mediaCapability
 * 'unknown' + isChatModel) — the modern GPT-5 family and gpt-4o all qualify. Only
 * if none of the user's own selections is usable do we fall back to gpt-4o.
 */
export function resolveVisionModel(settings: Settings): string {
  const isVisionChat = (id: string | undefined): id is string =>
    !!id && isChatModel('openai', id) && mediaCapability('openai', id) === 'unknown';
  const judge = bareId(settings.judgeModel);
  if (isVisionChat(judge)) return judge;
  if (settings.defaultTarget?.provider === 'openai' && isVisionChat(settings.defaultTarget.model)) {
    return settings.defaultTarget.model;
  }
  const discovered = (settings.availableModels?.openai ?? []).find(isVisionChat);
  return discovered ?? 'gpt-4o';
}

/** Per-provider fallback chat model when the user has no usable chat model selected. */
const DEFAULT_CHAT_MODEL: Record<ProviderId, string> = {
  openai: 'gpt-5.5',
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-2.5-pro',
};

/**
 * Resolve the chat model that RUNS the prompt-builder interview (the "architect").
 *
 * The builder must run on a real chat model. The bug this fixes: it used to run on
 * the TARGET, so selecting an image target (gpt-image-1) sent a chat request to an
 * image endpoint → 400, dead builder — and even a tiny target shouldn't be the one
 * writing the prompt. Prefer the target when it IS a chat model (the common case,
 * unchanged); otherwise fall back to the user's judge / default / discovered chat
 * model on the SAME provider (the key already loaded), then a per-provider default.
 */
export function resolveArchitectModel(settings: Settings, target: TargetModel): string {
  const isChat = (id: string | undefined): id is string =>
    !!id && isChatModel(target.provider, id) && mediaCapability(target.provider, id) === 'unknown';
  if (isChat(target.model)) return target.model;
  const judge = bareId(settings.judgeModel);
  if (isChat(judge)) return judge;
  if (settings.defaultTarget?.provider === target.provider && isChat(settings.defaultTarget.model)) {
    return settings.defaultTarget.model;
  }
  const discovered = (settings.availableModels?.[target.provider] ?? []).find(isChat);
  return discovered ?? DEFAULT_CHAT_MODEL[target.provider];
}

export function buildWiring(
  settings: Settings,
  target: TargetModel,
  factory: (id: ProviderId) => Provider,
): LoopWiring {
  const key = settings.keys[target.provider];
  if (!key) throw new Error(`Add your ${target.provider} key first (Settings → API keys).`);
  const provider = factory(target.provider);
  return {
    targetProvider: provider,
    targetKey: key,
    judgeProvider: provider,
    judgeKey: key,
    auxModel: resolveJudgeModel(settings, target),
  };
}
