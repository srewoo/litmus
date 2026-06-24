/**
 * List the models a given API key can actually access, so the panel offers real
 * options instead of guesses. One GET per provider; results are validated/parsed.
 */
import type { ProviderId } from '../shared/types';
import type { FetchLike } from './types';
import { ProviderError, defaultFetch } from './types';
import { isChatModel } from './capabilities';

const ENDPOINTS: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
};

function authHeaders(provider: ProviderId, key: string): Record<string, string> {
  if (provider === 'openai') return { Authorization: `Bearer ${key}` };
  if (provider === 'anthropic') {
    return {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
  return { 'x-goog-api-key': key };
}

export function parseOpenAIModels(json: unknown): string[] {
  const data = (json as { data?: Array<{ id?: unknown }> }).data ?? [];
  return data.map((d) => d.id).filter((id): id is string => typeof id === 'string');
}

export function parseAnthropicModels(json: unknown): string[] {
  const data = (json as { data?: Array<{ id?: unknown }> }).data ?? [];
  return data.map((d) => d.id).filter((id): id is string => typeof id === 'string');
}

export function parseGoogleModels(json: unknown): string[] {
  const models = (json as { models?: Array<{ name?: unknown }> }).models ?? [];
  return models
    .map((m) => m.name)
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.replace(/^models\//, ''));
}

function parseFor(provider: ProviderId, json: unknown): string[] {
  if (provider === 'openai') return parseOpenAIModels(json);
  if (provider === 'anthropic') return parseAnthropicModels(json);
  return parseGoogleModels(json);
}

/** Fetch and sort the accessible model ids for a provider key. Throws ProviderError on failure. */
export async function fetchModels(
  provider: ProviderId,
  key: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<string[]> {
  const res = await fetchImpl(ENDPOINTS[provider], { method: 'GET', headers: authHeaders(provider, key) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ProviderError(provider, res.status, detail);
  }
  const json: unknown = JSON.parse(await res.text());
  return parseFor(provider, json)
    .filter((id) => isChatModel(provider, id))
    .sort((a, b) => a.localeCompare(b));
}
