/** OpenAI chat-completions adapter (streaming). Decodes SSE deltas and times the stream. */
import type { ChatCallOptions, ChatMessage, ChatRequest, ChatResponse, Provider } from './types';
import { ProviderError, defaultFetch } from './types';
import type { ToolDef } from '../shared/types';
import { iterateSSE } from './sse';
import { supportsTemperature } from './capabilities';
import { timeChunkStream } from '../core/stream';
import { finalizeTiming } from '../core/timing';
import type { ToolAcc, ToolCallDelta } from './toolStream';
import { accumulateToolDeltas, assembleToolCalls } from './toolStream';

// Re-exported for existing tests that import these from this module.
export { assembleToolCalls } from './toolStream';
export type { ToolCallDelta } from './toolStream';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

interface ChunkParts {
  delta?: string;
  tokens?: number;
  toolCalls?: ToolCallDelta[];
}

/** Pull content delta, usage tokens, and tool-call fragments out of one SSE payload. */
export function parseOpenAIChunk(payload: string): ChunkParts {
  let json: {
    choices?: Array<{
      delta?: { content?: string; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> };
    }>;
    usage?: { total_tokens?: number };
    error?: { message?: string; type?: string; code?: string };
  };
  try {
    json = JSON.parse(payload) as typeof json;
  } catch {
    return {}; // skip a malformed/keep-alive frame rather than failing the run
  }
  // In-band error frame: OpenAI streams `{"error":{...}}` when the request fails
  // mid-stream. Surface it instead of silently returning a truncated success.
  if (json.error) {
    throw new ProviderError('openai', 0, json.error.message ?? json.error.type ?? 'stream error');
  }
  const out: ChunkParts = {};
  const delta = json.choices?.[0]?.delta;
  if (typeof delta?.content === 'string') out.delta = delta.content;
  if (typeof json.usage?.total_tokens === 'number') out.tokens = json.usage.total_tokens;
  if (Array.isArray(delta?.tool_calls)) {
    out.toolCalls = delta.tool_calls.map((tc, i) => ({
      index: tc.index ?? i,
      ...(tc.function?.name !== undefined ? { name: tc.function.name } : {}),
      ...(tc.function?.arguments !== undefined ? { argsFragment: tc.function.arguments } : {}),
    }));
  }
  return out;
}

/** Translate litmus tool defs into OpenAI's function-tool shape. */
function toOpenAITools(tools: readonly ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters },
  }));
}

/**
 * Serialize messages to OpenAI shape, handling multi-turn tool conversations.
 * Assistant tool calls get synthesized ids; the following tool turns reference
 * them in order (the agent loop emits results immediately after, same order).
 */
export function toOpenAIMessages(messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  const pendingIds: string[] = [];
  let counter = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const tool_calls = m.toolCalls.map((c) => {
        const id = `call_${counter++}`;
        pendingIds.push(id);
        return { id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } };
      });
      out.push({ role: 'assistant', content: m.content || null, tool_calls });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: pendingIds.shift() ?? `call_${counter++}`, content: m.content });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
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
        messages: toOpenAIMessages(request.messages),
        // Reasoning models (o-series) reject `temperature`; omit it for them.
        ...(supportsTemperature('openai', request.model) ? { temperature: request.temperature ?? 0 } : {}),
        max_tokens: request.maxTokens,
        ...(request.tools?.length ? { tools: toOpenAITools(request.tools) } : {}),
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
    const toolAcc: ToolAcc = new Map();
    const body = res.body;
    const signal = options.signal;
    async function* deltas(): AsyncIterable<string> {
      for await (const payload of iterateSSE(body, signal)) {
        const parts = parseOpenAIChunk(payload);
        if (parts.tokens !== undefined) tokens = parts.tokens;
        if (parts.toolCalls) accumulateToolDeltas(toolAcc, parts.toolCalls);
        if (parts.delta !== undefined) yield parts.delta;
      }
    }

    const measurement = await timeChunkStream(deltas(), startMs, clock);
    const toolCalls = assembleToolCalls(toolAcc);
    const response: ChatResponse = {
      text: measurement.text,
      timing: finalizeTiming(measurement, tokens),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    return tokens === undefined ? response : { ...response, tokens };
  }
}
