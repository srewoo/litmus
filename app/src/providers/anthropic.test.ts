import { describe, it, expect } from 'vitest';
import { AnthropicProvider, parseAnthropicChunk, toAnthropicMessages } from './anthropic';
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

describe('toAnthropicMessages', () => {
  it('extracts system and keeps plain turns as strings', () => {
    const { system, msgs } = toAnthropicMessages([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
    ]);
    expect(system).toBe('SYS');
    expect(msgs).toEqual([{ role: 'user', content: 'hi' }]);
  });
  it('serializes tool_use blocks and groups tool_result into a user turn with matching ids', () => {
    const { msgs } = toAnthropicMessages([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'checking', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] },
      { role: 'tool', toolName: 'get_weather', content: '{"tempC":18}' },
    ]);
    const asst = msgs[1] as { content: Array<{ type: string; id?: string; name?: string }> };
    const userResult = msgs[2] as { role: string; content: Array<{ type: string; tool_use_id: string }> };
    const useBlock = asst.content.find((b) => b.type === 'tool_use');
    expect(useBlock?.name).toBe('get_weather');
    expect(userResult.role).toBe('user');
    expect(userResult.content[0]?.tool_use_id).toBe(useBlock?.id); // ids match
  });
});

describe('parseAnthropicChunk', () => {
  it('should read a text delta', () => {
    expect(parseAnthropicChunk('{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}')).toEqual({ delta: 'hi' });
  });
  it('should read input and output token usage', () => {
    expect(parseAnthropicChunk('{"type":"message_start","message":{"usage":{"input_tokens":5}}}')).toEqual({ inputTokens: 5 });
    expect(parseAnthropicChunk('{"type":"message_delta","usage":{"output_tokens":2}}')).toEqual({ outputTokens: 2 });
  });
  it('should read an initial output_tokens from message_start (abort fallback)', () => {
    expect(
      parseAnthropicChunk('{"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}'),
    ).toEqual({ inputTokens: 5, outputTokens: 1 });
  });
  it('should include cache creation/read tokens in the input total', () => {
    expect(
      parseAnthropicChunk(
        '{"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":10,"cache_read_input_tokens":3}}}',
      ),
    ).toEqual({ inputTokens: 18 });
  });
  it('should throw a ProviderError on an in-band error frame', () => {
    expect(() => parseAnthropicChunk('{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}')).toThrow(ProviderError);
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

  it('should fail the run on a mid-stream error frame', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({
      ok: true,
      status: 200,
      body: streamFrom([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n',
        'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n',
      ]),
      text: async () => '',
    });
    await expect(
      new AnthropicProvider().chat(
        { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'k', fetchImpl, clock: fakeClock([0, 10, 20]) },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('should still count output tokens from message_start when message_delta is missing', async () => {
    const fetchImpl = async (): Promise<FetchResponse> => ({
      ok: true,
      status: 200,
      // No message_delta (e.g. aborted): output count comes from message_start's initial usage.
      body: streamFrom([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":4}}}\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n',
      ]),
      text: async () => '',
    });
    const res = await new AnthropicProvider().chat(
      { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'k', fetchImpl, clock: fakeClock([0, 10, 20]) },
    );
    // input total = 5 + 4 (cache_read) = 9, output = 1 → 10
    expect(res.tokens).toBe(10);
  });

  it('should send tools (input_schema) and assemble a streamed tool_use block', async () => {
    let captured: FetchInit | null = null;
    const fetchImpl = async (_url: string, init: FetchInit): Promise<FetchResponse> => {
      captured = init;
      return {
        ok: true,
        status: 200,
        body: streamFrom([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"get_weather"}}\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}\n',
        ]),
        text: async () => '',
      };
    };
    const res = await new AnthropicProvider().chat(
      {
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      },
      { apiKey: 'k', fetchImpl, clock: fakeClock([0, 10, 20]) },
    );
    expect(res.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(captured!.body).toContain('"input_schema"');
  });
});
