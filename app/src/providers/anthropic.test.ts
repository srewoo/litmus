import { describe, it, expect } from 'vitest';
import { AnthropicProvider, parseAnthropicChunk } from './anthropic';
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

describe('parseAnthropicChunk', () => {
  it('should read a text delta', () => {
    expect(parseAnthropicChunk('{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}')).toEqual({ delta: 'hi' });
  });
  it('should read input and output token usage', () => {
    expect(parseAnthropicChunk('{"type":"message_start","message":{"usage":{"input_tokens":5}}}')).toEqual({ inputTokens: 5 });
    expect(parseAnthropicChunk('{"type":"message_delta","usage":{"output_tokens":2}}')).toEqual({ outputTokens: 2 });
  });
});

describe('AnthropicProvider.chat', () => {
  it('should assemble text, sum tokens, and send the browser-access header + system field', async () => {
    let captured: { url: string; init: FetchInit } | null = null;
    const fetchImpl = async (url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        body: streamFrom([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n',
          'data: {"type":"message_delta","usage":{"output_tokens":2}}\n',
        ]),
        text: async () => '',
      };
    };

    const res = await new AnthropicProvider().chat(
      { model: 'claude-sonnet-4.6', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] },
      { apiKey: 'sk-ant', fetchImpl, clock: fakeClock([1000, 1120, 1500]), signal: new AbortController().signal },
    );

    expect(res.text).toBe('Hello');
    expect(res.tokens).toBe(7);
    expect(res.timing.ttfbMs).toBe(120);
    expect(captured!.init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(captured!.init.body).toContain('"system":"SYS"');
  });

  it('should throw a ProviderError on a non-OK response', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({ ok: false, status: 401, body: null, text: async () => 'bad' });
    await expect(
      new AnthropicProvider().chat({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x' }] }, { apiKey: 'k', fetchImpl }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
