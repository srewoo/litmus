import { describe, it, expect } from 'vitest';
import { GoogleProvider, parseGoogleChunk } from './google';
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
});
