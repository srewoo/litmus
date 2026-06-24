/**
 * Adapter (ADR 0002, slice a.2): turn a Provider into the agent loop's ModelStep.
 * Maps the loop's AgentTurns to ChatMessages (which now carry tool calls + tool
 * results), sends the scenario's tools, and returns the model's text + tool calls.
 */
import type { Provider, ChatMessage, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import type { ToolDef } from '../shared/types';
import type { ModelStep, AgentTurn } from './agentRun';
import { chatOptions } from './opts';

export interface AgentStepDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly tools: readonly ToolDef[];
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

function toChatMessages(turns: readonly AgentTurn[]): ChatMessage[] {
  return turns.map((t) => ({
    role: t.role,
    content: t.content,
    ...(t.toolCalls ? { toolCalls: t.toolCalls } : {}),
    ...(t.toolName ? { toolName: t.toolName } : {}),
  }));
}

/** Build a ModelStep backed by a real provider. */
export function providerStep(deps: AgentStepDeps): ModelStep {
  return async (turns) => {
    const res = await deps.provider.chat(
      { model: deps.model, messages: toChatMessages(turns), tools: deps.tools },
      chatOptions(deps),
    );
    return { text: res.text, toolCalls: res.toolCalls ?? [] };
  };
}
