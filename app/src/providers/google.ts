/** Google Gemini adapter (streaming via :streamGenerateContent?alt=sse). */
import type { ChatCallOptions, ChatMessage, ChatRequest, ChatResponse, Provider } from './types';
import { ProviderError, defaultFetch } from './types';
import type { ToolCall, ToolDef } from '../shared/types';
import { iterateSSE } from './sse';
import { timeChunkStream } from '../core/stream';
import { finalizeTiming } from '../core/timing';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

interface ChunkParts {
  delta?: string;
  tokens?: number;
  /** Gemini emits whole functionCall objects (args already parsed) — no fragments. */
  toolCalls?: ToolCall[];
}

export function parseGoogleChunk(payload: string): ChunkParts {
  try {
    const json = JSON.parse(payload) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> } }>;
      usageMetadata?: { totalTokenCount?: number };
    };
    const out: ChunkParts = {};
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('');
    if (text.length > 0) out.delta = text;
    const calls = parts
      .filter((p) => p.functionCall?.name)
      .map((p) => ({ name: p.functionCall!.name as string, arguments: p.functionCall!.args ?? {} }));
    if (calls.length > 0) out.toolCalls = calls;
    if (typeof json.usageMetadata?.totalTokenCount === 'number') out.tokens = json.usageMetadata.totalTokenCount;
    return out;
  } catch {
    return {};
  }
}

/** Translate litmus tool defs into Gemini's functionDeclarations shape. */
function toGoogleTools(tools: readonly ToolDef[]): unknown {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters,
      })),
    },
  ];
}

/** Parse a tool-result string back into the object Gemini's functionResponse expects. */
function toResponseObject(content: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(content);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v };
  } catch {
    return { result: content };
  }
}

/**
 * Serialize to Gemini `contents`, handling multi-turn tools: assistant tool calls
 * become `functionCall` parts on a model turn; tool results become `functionResponse`
 * parts on a user turn (Gemini matches by name, so no ids are needed).
 */
function toContents(messages: readonly ChatMessage[]): { system: string; contents: unknown[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.toolName ?? '', response: toResponseObject(m.content) } }] });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: unknown[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.arguments ?? {} } });
      contents.push({ role: 'model', parts });
    } else {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    }
  }
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
        ...(request.tools?.length ? { tools: toGoogleTools(request.tools) } : {}),
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
    const toolCalls: ToolCall[] = [];
    const body = res.body;
    async function* deltas(): AsyncIterable<string> {
      for await (const payload of iterateSSE(body)) {
        const p = parseGoogleChunk(payload);
        if (p.tokens !== undefined) tokens = p.tokens;
        if (p.toolCalls) toolCalls.push(...p.toolCalls);
        if (p.delta !== undefined) yield p.delta;
      }
    }

    const measurement = await timeChunkStream(deltas(), startMs, clock);
    const response: ChatResponse = {
      text: measurement.text,
      timing: finalizeTiming(measurement, tokens),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    return tokens === undefined ? response : { ...response, tokens };
  }
}
