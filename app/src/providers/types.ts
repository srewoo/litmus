/** Provider abstraction. Adapters call a real LLM; the core depends only on this interface. */
import type { ProviderId, Timing, ToolCall, ToolDef } from '../shared/types';
import type { Clock } from '../core/stream';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** On an assistant turn: the tool calls it made (ADR 0002 multi-turn). */
  readonly toolCalls?: readonly ToolCall[];
  /** On a tool turn: which tool this result is for. */
  readonly toolName?: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Tools the model may call (ADR 0001). Adapters translate to native format. */
  readonly tools?: readonly ToolDef[];
}

export interface ChatResponse {
  readonly text: string;
  readonly timing: Timing;
  /** Provider-reported total tokens, when available. */
  readonly tokens?: number;
  /** Tool calls the model emitted, normalized across providers (ADR 0001). */
  readonly toolCalls?: readonly ToolCall[];
}

/** Per-call dependencies, all injectable so adapters are testable without network. */
export interface ChatCallOptions {
  readonly apiKey: string;
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
  readonly fetchImpl?: FetchLike;
}

export interface Provider {
  readonly id: ProviderId;
  chat(request: ChatRequest, options: ChatCallOptions): Promise<ChatResponse>;
}

/* ---- Minimal fetch surface litmus relies on (the global `fetch` satisfies it) ---- */

export interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  /** Omitted for GET requests (e.g. model listing). */
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export function defaultFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike;
}

/** Raised when a provider returns a non-OK HTTP status. Carries the status for retry/backoff. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
    readonly detail: string,
    readonly model?: string,
  ) {
    super(`[${provider}] HTTP ${status}${model ? ` (model ${model})` : ''}: ${detail.slice(0, 200)}`);
    this.name = 'ProviderError';
  }
}
