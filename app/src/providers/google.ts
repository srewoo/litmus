/** Google Gemini adapter (streaming via :streamGenerateContent?alt=sse). */
import type { ChatCallOptions, ChatMessage, ChatRequest, ChatResponse, Provider } from './types';
import { ProviderError, defaultFetch } from './types';
import { iterateSSE } from './sse';
import { timeChunkStream } from '../core/stream';
import { finalizeTiming } from '../core/timing';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

interface ChunkParts {
  delta?: string;
  tokens?: number;
}

export function parseGoogleChunk(payload: string): ChunkParts {
  try {
    const json = JSON.parse(payload) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { totalTokenCount?: number };
    };
    const out: ChunkParts = {};
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('');
    if (text.length > 0) out.delta = text;
    if (typeof json.usageMetadata?.totalTokenCount === 'number') out.tokens = json.usageMetadata.totalTokenCount;
    return out;
  } catch {
    return {};
  }
}

function toContents(messages: readonly ChatMessage[]): { system: string; contents: unknown[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  return { system, contents };
}

export class GoogleProvider implements Provider {
  readonly id = 'google' as const;

  async chat(request: ChatRequest, options: ChatCallOptions): Promise<ChatResponse> {
    const fetchImpl = options.fetchImpl ?? defaultFetch();
    const clock = options.clock ?? (() => performance.now());
    const startMs = clock();
    const { system, contents } = toContents(request.messages);

    const init: Parameters<typeof fetchImpl>[1] = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          temperature: request.temperature ?? 0,
          ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
        },
      }),
    };
    if (options.signal) Object.assign(init, { signal: options.signal });

    const url = `${BASE}${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
    const res = await fetchImpl(url, init);
    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError('google', res.status, detail, request.model);
    }

    let tokens: number | undefined;
    const body = res.body;
    async function* deltas(): AsyncIterable<string> {
      for await (const payload of iterateSSE(body)) {
        const p = parseGoogleChunk(payload);
        if (p.tokens !== undefined) tokens = p.tokens;
        if (p.delta !== undefined) yield p.delta;
      }
    }

    const measurement = await timeChunkStream(deltas(), startMs, clock);
    const response: ChatResponse = { text: measurement.text, timing: finalizeTiming(measurement, tokens) };
    return tokens === undefined ? response : { ...response, tokens };
  }
}
