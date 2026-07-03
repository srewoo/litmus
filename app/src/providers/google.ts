/** Google Gemini adapter (streaming via :streamGenerateContent?alt=sse). */
import type { ChatCallOptions, ChatMessage, ChatRequest, ChatResponse, Provider } from './types';
import { ProviderError, defaultFetch, DEFAULT_MAX_TOKENS } from './types';
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
  let json: {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> } }>;
    usageMetadata?: { totalTokenCount?: number };
    error?: { code?: number; message?: string; status?: string };
  };
  try {
    json = JSON.parse(payload) as typeof json;
  } catch {
    return {};
  }
  // In-band error frame: Gemini streams `{"error":{...}}` on a mid-stream failure.
  // Surface it instead of returning a truncated success.
  if (json.error) {
    throw new ProviderError('google', json.error.code ?? 0, json.error.message ?? json.error.status ?? 'stream error');
  }
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
export function toContents(messages: readonly ChatMessage[]): { system: string; contents: unknown[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      // Gemini matches a functionResponse to its call by name — an empty name never
      // matches and the request is rejected, so require it explicitly.
      if (!m.toolName) {
        throw new Error('google: tool result is missing toolName (required to match functionResponse by name)');
      }
      // Parallel tool calls in one assistant turn produce consecutive `tool`
      // results. Gemini expects ALL their functionResponse parts grouped in the
      // single following user turn — consecutive user entries can be rejected — so
      // append onto the current user turn instead of opening a new one each time.
      const part = { functionResponse: { name: m.toolName, response: toResponseObject(m.content) } };
      const prev = contents[contents.length - 1];
      if (prev && prev.role === 'user') prev.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: unknown[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.arguments ?? {} } });
      contents.push({ role: 'model', parts });
    } else {
      // Gemini rejects an empty text part (parts:[{text:''}]); skip empty content.
      if (m.content.length === 0) continue;
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
          maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
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
    const signal = options.signal;
    async function* deltas(): AsyncIterable<string> {
      for await (const payload of iterateSSE(body, signal)) {
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
