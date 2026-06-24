/** OpenAI chat-completions adapter (streaming). Decodes SSE deltas and times the stream. */
import type { ChatCallOptions, ChatRequest, ChatResponse, Provider } from './types';
import { ProviderError, defaultFetch } from './types';
import { iterateSSE } from './sse';
import { supportsTemperature } from './capabilities';
import { timeChunkStream } from '../core/stream';
import { finalizeTiming } from '../core/timing';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

interface ChunkParts {
  delta?: string;
  tokens?: number;
}

/** Pull the content delta and (final) usage token count out of one SSE payload. */
export function parseOpenAIChunk(payload: string): ChunkParts {
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const out: ChunkParts = {};
    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') out.delta = delta;
    if (typeof json.usage?.total_tokens === 'number') out.tokens = json.usage.total_tokens;
    return out;
  } catch {
    return {}; // skip a malformed/keep-alive frame rather than failing the run
  }
}

export class OpenAIProvider implements Provider {
  readonly id = 'openai' as const;

  async chat(request: ChatRequest, options: ChatCallOptions): Promise<ChatResponse> {
    const fetchImpl = options.fetchImpl ?? defaultFetch();
    const clock = options.clock ?? (() => performance.now());
    const startMs = clock();

    const init: Parameters<typeof fetchImpl>[1] = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        // Reasoning models (o-series) reject `temperature`; omit it for them.
        ...(supportsTemperature('openai', request.model) ? { temperature: request.temperature ?? 0 } : {}),
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
    };
    if (options.signal) Object.assign(init, { signal: options.signal });

    const res = await fetchImpl(ENDPOINT, init);
    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError('openai', res.status, detail, request.model);
    }

    let tokens: number | undefined;
    const body = res.body;
    async function* deltas(): AsyncIterable<string> {
      for await (const payload of iterateSSE(body)) {
        const parts = parseOpenAIChunk(payload);
        if (parts.tokens !== undefined) tokens = parts.tokens;
        if (parts.delta !== undefined) yield parts.delta;
      }
    }

    const measurement = await timeChunkStream(deltas(), startMs, clock);
    const response: ChatResponse = { text: measurement.text, timing: finalizeTiming(measurement, tokens) };
    return tokens === undefined ? response : { ...response, tokens };
  }
}
