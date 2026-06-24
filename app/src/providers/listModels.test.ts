import { describe, it, expect } from 'vitest';
import { parseOpenAIModels, parseAnthropicModels, parseGoogleModels, fetchModels } from './listModels';
import type { FetchInit, FetchResponse } from './types';
import { ProviderError } from './types';

describe('model list parsers', () => {
  it('should read OpenAI/Anthropic data[].id', () => {
    expect(parseOpenAIModels({ data: [{ id: 'gpt-4o' }, { id: 'o3' }, { id: 5 }] })).toEqual(['gpt-4o', 'o3']);
    expect(parseAnthropicModels({ data: [{ id: 'claude-haiku-4-5' }] })).toEqual(['claude-haiku-4-5']);
  });
  it('should strip the models/ prefix for Google', () => {
    expect(parseGoogleModels({ models: [{ name: 'models/gemini-3.5-pro' }] })).toEqual(['gemini-3.5-pro']);
  });
  it('should tolerate missing arrays', () => {
    expect(parseOpenAIModels({})).toEqual([]);
    expect(parseGoogleModels({})).toEqual([]);
  });
});

describe('fetchModels', () => {
  it('should GET the right endpoint with auth and return sorted ids', async () => {
    let captured: { url: string; init: FetchInit } | null = null;
    const fetchImpl = async (url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = { url, init };
      return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ data: [{ id: 'o3' }, { id: 'gpt-4o' }] }) };
    };
    const ids = await fetchModels('openai', 'sk', fetchImpl);
    expect(ids).toEqual(['gpt-4o', 'o3']); // sorted
    expect(captured!.url).toContain('/v1/models');
    expect(captured!.init.method).toBe('GET');
    expect(captured!.init.headers['Authorization']).toBe('Bearer sk');
    expect(captured!.init.body).toBeUndefined();
  });

  it('should send Google key header and strip prefixes', async () => {
    const fetchImpl = async (_u: string, _i: FetchInit): Promise<FetchResponse> => ({
      ok: true,
      status: 200,
      body: null,
      text: async () => JSON.stringify({ models: [{ name: 'models/gemini-3.5-flash' }] }),
    });
    expect(await fetchModels('google', 'g', fetchImpl)).toEqual(['gemini-3.5-flash']);
  });

  it('should filter out non-chat OpenAI models', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({
      ok: true,
      status: 200,
      body: null,
      text: async () => JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }] }),
    });
    expect(await fetchModels('openai', 'sk', fetchImpl)).toEqual(['gpt-4o']);
  });

  it('should throw a ProviderError on a non-OK response', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({ ok: false, status: 401, body: null, text: async () => 'nope' });
    await expect(fetchModels('anthropic', 'bad', fetchImpl)).rejects.toBeInstanceOf(ProviderError);
  });
});
