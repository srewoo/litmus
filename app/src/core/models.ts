/**
 * Current model catalog (verified June 2026). The capture dropdown lists the
 * actual model — it's the variable under test — grouped by family. IDs drift and
 * BYOK access varies, so Settings also offers a free-form custom model ID.
 */
import type { ProviderId } from '../shared/types';

export interface ModelOption {
  readonly id: string;
  readonly label: string;
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
};

export const MODEL_CATALOG: Record<ProviderId, readonly ModelOption[]> = {
  openai: [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'o3', label: 'o3' },
  ],
  anthropic: [
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  google: [
    { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
};

export const PROVIDER_ORDER: readonly ProviderId[] = ['openai', 'anthropic', 'google'];

/** Default target shown on first run. */
export const DEFAULT_TARGET_VALUE = 'openai/gpt-5.5';
