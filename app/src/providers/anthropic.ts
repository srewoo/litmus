/** Anthropic Messages adapter (streaming). Needs the browser-access opt-in header for BYOK. */
import type { ChatCallOptions, ChatMessage, ChatRequest, ChatResponse, Provider } from './types';
import { ProviderError, defaultFetch } from './types';
import { iterateSSE } from './sse';
import { timeChunkStream } from '../core/stream';
import { finalizeTiming } from '../core/timing';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

interface ChunkParts {
  delta?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export function parseAnthropicChunk(payload: string): ChunkParts {
  try {
    const json = JSON.parse(payload) as {
      type?: string;
      delta?: { text?: string };
      message?: { usage?: { input_tokens?: number } };
      usage?: { output_tokens?: number };
    };
    const out: ChunkParts = {};
    if (json.type === 'content_block_delta' && typeof json.delta?.text === 'string') out.delta = json.delta.text;
    if (typeof json.message?.usage?.input_tokens === 'number') out.inputTokens = json.message.usage.input_tokens;
    if (typeof json.usage?.output_tokens === 'number') out.outputTokens = json.usage.output_tokens;
    return out;
  } catch {
    return {};
  }
}

/** Split litmus messages into Anthropic's top-level `system` plus user/assistant turns. */
function splitSystem(messages: readonly ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }));
  return { system, rest };
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;

  async chat(request: ChatRequest, options: ChatCallOptions): Promise<ChatResponse> {
    const fetchImpl = options.fetchImpl ?? defaultFetch();
    const clock = options.clock ?? (() => performance.now());
    const startMs = clock();
    const { system, rest } = splitSystem(request.messages);

    const init: Parameters<typeof fetchImpl>[1] = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0,
        stream: true,
        ...(system ? { system } : {}),
        messages: rest,
      }),
    };
    if (options.signal) Object.assign(init, { signal: options.signal });

    const res = await fetchImpl(ENDPOINT, init);
    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError('anthropic', res.status, detail, request.model);
    }

    let inTok: number | undefined;
    let outTok: number | undefined;
    const body = res.body;
    async function* deltas(): AsyncIterable<string> {
      for await (const payload of iterateSSE(body)) {
        const p = parseAnthropicChunk(payload);
        if (p.inputTokens !== undefined) inTok = p.inputTokens;
        if (p.outputTokens !== undefined) outTok = p.outputTokens;
        if (p.delta !== undefined) yield p.delta;
      }
    }

    const measurement = await timeChunkStream(deltas(), startMs, clock);
    const tokens = inTok !== undefined || outTok !== undefined ? (inTok ?? 0) + (outTok ?? 0) : undefined;
    const response: ChatResponse = { text: measurement.text, timing: finalizeTiming(measurement, tokens) };
    return tokens === undefined ? response : { ...response, tokens };
  }
}
