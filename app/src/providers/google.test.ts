import { describe, it, expect } from 'vitest';
import { GoogleProvider, parseGoogleChunk, toContents } from './google';
import type { FetchInit, FetchResponse } from './types';
import { ProviderError } from './types';

function streamFrom(frames: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}
function fakeClock(seq: readonly number[]): () => number {
  let i = 0;
  return () => seq[i++] ?? seq[seq.length - 1] ?? 0;
}

describe('parseGoogleChunk', () => {
  it('should join candidate part text', () => {
    expect(parseGoogleChunk('{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}')).toEqual({ delta: 'hi' });
  });
  it('should read the total token count', () => {
    expect(parseGoogleChunk('{"candidates":[],"usageMetadata":{"totalTokenCount":9}}')).toEqual({ tokens: 9 });
  });
  it('should return empty parts for a malformed frame', () => {
    expect(parseGoogleChunk('not json')).toEqual({});
  });
  it('should throw a ProviderError on an in-band error frame', () => {
    expect(() => parseGoogleChunk('{"error":{"code":429,"message":"quota exceeded","status":"RESOURCE_EXHAUSTED"}}')).toThrow(ProviderError);
  });
});

describe('toContents', () => {
  it('should emit the functionResponse name from toolName', () => {
    const { contents } = toContents([{ role: 'tool', toolName: 'get_weather', content: '{"tempC":18}' }]);
    const part = (contents[0] as { parts: Array<{ functionResponse: { name: string } }> }).parts[0];
    expect(part?.functionResponse.name).toBe('get_weather');
  });
  it('should throw when a tool result is missing its toolName', () => {
    expect(() => toContents([{ role: 'tool', content: '{}' }])).toThrow();
  });
  it('should skip an empty-text user/assistant turn rather than emit parts:[{text:""}]', () => {
    const { contents } = toContents([
      { role: 'user', content: '' },
      { role: 'user', content: 'hi' },
    ]);
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });
});

describe('GoogleProvider.chat', () => {
  it('should assemble text, capture tokens, target the model endpoint, and send the key header', async () => {
    let captured: { url: string; init: FetchInit } | null = null;
    const fetchImpl = async (url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        body: streamFrom([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"totalTokenCount":9}}\n',
        ]),
        text: async () => '',
      };
    };

    const res = await new GoogleProvider().chat(
      { model: 'gemini-2.5-pro', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] },
      { apiKey: 'g-key', fetchImpl, clock: fakeClock([1000, 1120, 1500]), signal: new AbortController().signal },
    );

    expect(res.text).toBe('Hello');
    expect(res.tokens).toBe(9);
    expect(res.timing.totalMs).toBe(500);
    expect(captured!.url).toContain('gemini-2.5-pro:streamGenerateContent');
    expect(captured!.init.headers['x-goog-api-key']).toBe('g-key');
    expect(captured!.init.body).toContain('systemInstruction');
  });

  it('should throw a ProviderError on a non-OK response', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({ ok: false, status: 403, body: null, text: async () => 'denied' });
    await expect(
      new GoogleProvider().chat({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'x' }] }, { apiKey: 'k', fetchImpl }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('should serialize a multi-turn tool conversation into functionCall + functionResponse parts', async () => {
    let captured: FetchInit | null = null;
    const fetchImpl = async (_url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = init;
      return { ok: true, status: 200, body: streamFrom(['data: {"candidates":[{"content":{"parts":[{"text":"done"}]}}]}\n']), text: async () => '' };
    };
    await new GoogleProvider().chat(
      {
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: '', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] },
          { role: 'tool', toolName: 'get_weather', content: '{"tempC":18}' },
        ],
      },
      { apiKey: 'g', fetchImpl, clock: fakeClock([0, 10, 20]) },
    );
    expect(captured!.body).toContain('"functionCall"');
    expect(captured!.body).toContain('"functionResponse"');
    expect(captured!.body).toContain('"role":"model"');
  });

  it('should fail the run on a mid-stream error frame', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({
      ok: true,
      status: 200,
      body: streamFrom([
        'data: {"candidates":[{"content":{"parts":[{"text":"par"}]}}]}\n',
        'data: {"error":{"code":429,"message":"quota exceeded","status":"RESOURCE_EXHAUSTED"}}\n',
      ]),
      text: async () => '',
    });
    await expect(
      new GoogleProvider().chat(
        { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'g', fetchImpl, clock: fakeClock([0, 10, 20]) },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('should send functionDeclarations and collect a functionCall part', async () => {
    let captured: FetchInit | null = null;
    const fetchImpl = async (_url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = init;
      return {
        ok: true,
        status: 200,
        body: streamFrom([
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]}}]}\n',
        ]),
        text: async () => '',
      };
    };
    const res = await new GoogleProvider().chat(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      },
      { apiKey: 'g', fetchImpl, clock: fakeClock([0, 10, 20]) },
    );
    expect(res.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(captured!.body).toContain('functionDeclarations');
  });
});
