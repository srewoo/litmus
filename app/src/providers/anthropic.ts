/** Anthropic Messages adapter (streaming). Needs the browser-access opt-in header for BYOK. */
import type { ChatCallOptions, ChatMessage, ChatRequest, ChatResponse, Provider } from './types';
import { ProviderError, defaultFetch } from './types';
import type { ToolDef } from '../shared/types';
import { iterateSSE } from './sse';
import { timeChunkStream } from '../core/stream';
import { finalizeTiming } from '../core/timing';
import type { ToolAcc, ToolCallDelta } from './toolStream';
import { accumulateToolDeltas, assembleToolCalls } from './toolStream';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

interface ChunkParts {
  delta?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: ToolCallDelta[];
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Sum the input-side tokens, including cache creation/read tokens when present. */
function inputTotal(u: AnthropicUsage): number | undefined {
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens];
  if (parts.every((p) => typeof p !== 'number')) return undefined;
  return parts.reduce<number>((sum, p) => sum + (typeof p === 'number' ? p : 0), 0);
}

export function parseAnthropicChunk(payload: string): ChunkParts {
  let json: {
    type?: string;
    index?: number;
    content_block?: { type?: string; name?: string };
    delta?: { text?: string; type?: string; partial_json?: string };
    message?: { usage?: AnthropicUsage };
    usage?: AnthropicUsage;
    error?: { type?: string; message?: string };
  };
  try {
    json = JSON.parse(payload) as typeof json;
  } catch {
    return {};
  }
  // In-band error frame: Anthropic streams `{"type":"error","error":{...}}` on a
  // mid-stream failure (e.g. overloaded). Surface it instead of dropping it.
  if (json.type === 'error' || json.error) {
    throw new ProviderError('anthropic', 0, json.error?.message ?? json.error?.type ?? 'stream error');
  }
  const out: ChunkParts = {};
  const idx = json.index ?? 0;
  // A tool_use block opens → record its name at this index.
  if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
    out.toolCalls = [{ index: idx, ...(json.content_block.name ? { name: json.content_block.name } : {}) }];
  }
  if (json.type === 'content_block_delta') {
    if (typeof json.delta?.text === 'string') out.delta = json.delta.text;
    // Tool arguments stream as input_json_delta fragments.
    if (json.delta?.type === 'input_json_delta' && typeof json.delta.partial_json === 'string') {
      out.toolCalls = [{ index: idx, argsFragment: json.delta.partial_json }];
    }
  }
  // message_start carries the initial usage (input tokens + an initial output_tokens);
  // message_delta carries the final output_tokens. Both may include cache tokens.
  if (json.message?.usage) {
    const it = inputTotal(json.message.usage);
    if (it !== undefined) out.inputTokens = it;
    if (typeof json.message.usage.output_tokens === 'number') out.outputTokens = json.message.usage.output_tokens;
  }
  if (json.usage) {
    const it = inputTotal(json.usage);
    if (it !== undefined) out.inputTokens = it;
    if (typeof json.usage.output_tokens === 'number') out.outputTokens = json.usage.output_tokens;
  }
  return out;
}

/** Translate litmus tool defs into Anthropic's tool shape (uses `input_schema`). */
function toAnthropicTools(tools: readonly ToolDef[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.parameters,
  }));
}

/**
 * Serialize to Anthropic's top-level `system` + messages, handling multi-turn
 * tool conversations: assistant tool calls become `tool_use` blocks; tool results
 * become `tool_result` blocks grouped into the following user message. tool_use
 * ids are synthesized and matched to results in order (the agent loop guarantees
 * results immediately follow their call, same order).
 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): { system: string; msgs: unknown[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const msgs: unknown[] = [];
  const idQueue: string[] = [];
  let pending: unknown[] = [];
  let counter = 0;
  const flush = (): void => {
    if (pending.length) {
      msgs.push({ role: 'user', content: pending });
      pending = [];
    }
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      pending.push({ type: 'tool_result', tool_use_id: idQueue.shift() ?? `toolu_${counter++}`, content: m.content });
      continue;
    }
    flush();
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: unknown[] = m.content ? [{ type: 'text', text: m.content }] : [];
      for (const c of m.toolCalls) {
        const id = `toolu_${counter++}`;
        idQueue.push(id);
        blocks.push({ type: 'tool_use', id, name: c.name, input: c.arguments ?? {} });
      }
      msgs.push({ role: 'assistant', content: blocks });
    } else {
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  flush();
  return { system, msgs };
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;

  async chat(request: ChatRequest, options: ChatCallOptions): Promise<ChatResponse> {
    const fetchImpl = options.fetchImpl ?? defaultFetch();
    const clock = options.clock ?? (() => performance.now());
    const startMs = clock();
    const { system, msgs } = toAnthropicMessages(request.messages);

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
        ...(request.tools?.length ? { tools: toAnthropicTools(request.tools) } : {}),
        messages: msgs,
      }),
    };
    if (options.signal) Object.assign(init, { signal: options.signal });

    const res = await fetchImpl(ENDPOINT, init);
    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError('anthropic', res.status, detail, request.model);
    }

    let inTok: number | undefined;
    // Output tokens: message_start carries an initial count, message_delta the final.
    // We keep the latest seen, so an aborted stream missing message_delta still falls
    // back to message_start's initial output_tokens rather than leaving it undefined.
    let outTok: number | undefined;
    const toolAcc: ToolAcc = new Map();
    const body = res.body;
    const signal = options.signal;
    async function* deltas(): AsyncIterable<string> {
      for await (const payload of iterateSSE(body, signal)) {
        const p = parseAnthropicChunk(payload);
        if (p.inputTokens !== undefined) inTok = p.inputTokens;
        if (p.outputTokens !== undefined) outTok = p.outputTokens;
        if (p.toolCalls) accumulateToolDeltas(toolAcc, p.toolCalls);
        if (p.delta !== undefined) yield p.delta;
      }
    }

    const measurement = await timeChunkStream(deltas(), startMs, clock);
    // Report a total only if we saw any usage; default each side to 0 so a missing
    // output count (aborted before message_delta) still includes the input total
    // rather than reporting input-only as a silent full total.
    const tokens = inTok !== undefined || outTok !== undefined ? (inTok ?? 0) + (outTok ?? 0) : undefined;
    const toolCalls = assembleToolCalls(toolAcc);
    const response: ChatResponse = {
      text: measurement.text,
      timing: finalizeTiming(measurement, tokens),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    return tokens === undefined ? response : { ...response, tokens };
  }
}
