import { describe, it, expect } from 'vitest';
import { OpenAIProvider, parseOpenAIChunk, assembleToolCalls, toOpenAIMessages } from './openai';
import type { FetchInit, FetchResponse } from './types';
import { ProviderError } from './types';

function streamFrom(frames: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

function fakeClock(sequence: readonly number[]): () => number {
  let i = 0;
  return () => sequence[i++] ?? sequence[sequence.length - 1] ?? 0;
}

describe('parseOpenAIChunk', () => {
  it('should extract a content delta', () => {
    expect(parseOpenAIChunk('{"choices":[{"delta":{"content":"hi"}}]}')).toEqual({ delta: 'hi' });
  });
  it('should extract usage tokens from the final chunk', () => {
    expect(parseOpenAIChunk('{"choices":[],"usage":{"total_tokens":12}}')).toEqual({ tokens: 12 });
  });
  it('should return empty parts for a malformed frame', () => {
    expect(parseOpenAIChunk('not json')).toEqual({});
  });
  it('should extract tool-call fragments', () => {
    const parts = parseOpenAIChunk('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}');
    expect(parts.toolCalls).toEqual([{ index: 0, name: 'get_weather', argsFragment: '{"ci' }]);
  });
});

describe('toOpenAIMessages', () => {
  it('passes plain messages through unchanged', () => {
    expect(toOpenAIMessages([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });
  it('serializes a tool conversation with matching tool_call_id', () => {
    const out = toOpenAIMessages([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'checking', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] },
      { role: 'tool', toolName: 'get_weather', content: '{"tempC":18}' },
    ]) as Array<Record<string, unknown>>;
    const asst = out[1] as { tool_calls: Array<{ id: string; function: { arguments: string } }> };
    const tool = out[2] as { tool_call_id: string };
    expect(asst.tool_calls[0]?.function.arguments).toBe('{"city":"Paris"}');
    expect(tool.tool_call_id).toBe(asst.tool_calls[0]?.id); // ids match
  });
});

describe('assembleToolCalls', () => {
  it('joins argument fragments and parses JSON', () => {
    const acc = new Map([[0, { name: 'get_weather', args: '{"city":"Paris"}' }]]);
    expect(assembleToolCalls(acc)).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
  });
  it('keeps the raw string when arguments are not valid JSON', () => {
    const acc = new Map([[0, { name: 'f', args: '{bad' }]]);
    expect(assembleToolCalls(acc)).toEqual([{ name: 'f', arguments: undefined, rawArguments: '{bad' }]);
  });
  it('drops fragments that never received a name', () => {
    expect(assembleToolCalls(new Map([[0, { name: '', args: '{}' }]]))).toEqual([]);
  });
});

describe('OpenAIProvider.chat', () => {
  it('should assemble streamed text, time it, and report usage tokens', async () => {
    let captured: { url: string; init: FetchInit } | null = null;
    const fetchImpl = async (url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        body: streamFrom([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
          'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":7}}\n',
          'data: [DONE]\n',
        ]),
        text: async () => '',
      };
    };

    const provider = new OpenAIProvider();
    // clock: start, first-delta, end → ttfb 120, total 500
    const res = await provider.chat(
      { model: 'gpt-5.1', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'sk-test', fetchImpl, clock: fakeClock([1000, 1120, 1500]), signal: new AbortController().signal },
    );

    expect(res.text).toBe('Hello');
    expect(res.tokens).toBe(7);
    expect(res.timing.ttfbMs).toBe(120);
    expect(res.timing.totalMs).toBe(500);
    expect(res.timing.tokensPerSec).toBe(14); // 7 tokens / 0.5s

    expect(captured!.url).toContain('openai.com');
    expect(captured!.init.headers['Authorization']).toBe('Bearer sk-test');
    expect(captured!.init.body).toContain('"stream":true');
  });

  it('should omit temperature for reasoning models (o-series)', async () => {
    let captured: FetchInit | null = null;
    const fetchImpl = async (_url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = init;
      return { ok: true, status: 200, body: streamFrom(['data: [DONE]\n']), text: async () => '' };
    };
    await new OpenAIProvider().chat(
      { model: 'o3', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'sk', fetchImpl, clock: fakeClock([1, 2]) },
    );
    expect(captured!.body).toContain('"model":"o3"');
    expect(captured!.body).not.toContain('temperature');
  });

  it('should include the model id in a ProviderError', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({ ok: false, status: 400, body: null, text: async () => 'invalid model ID' });
    await new OpenAIProvider()
      .chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] }, { apiKey: 'k', fetchImpl })
      .catch((err: unknown) => {
        expect((err as { model?: string }).model).toBe('gpt-x');
      });
  });

  it('should throw a ProviderError on a non-OK response', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({
      ok: false,
      status: 401,
      body: null,
      text: async () => 'invalid key',
    });
    const provider = new OpenAIProvider();
    await expect(
      provider.chat(
        { model: 'gpt-5.1', messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'bad', fetchImpl },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('should send tools and assemble streamed tool calls across chunks', async () => {
    let captured: FetchInit | null = null;
    const fetchImpl = async (_url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = init;
      return {
        ok: true,
        status: 200,
        body: streamFrom([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}\n',
          'data: [DONE]\n',
        ]),
        text: async () => '',
      };
    };
    const provider = new OpenAIProvider();
    const res = await provider.chat(
      {
        model: 'gpt-5.1',
        messages: [{ role: 'user', content: 'weather in Paris?' }],
        tools: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      },
      { apiKey: 'sk', fetchImpl, clock: fakeClock([0, 10, 20]) },
    );
    expect(res.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(captured!.body).toContain('"tools"');
    expect(captured!.body).toContain('"type":"function"');
  });
});
