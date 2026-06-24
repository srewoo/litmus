/**
 * Shared streaming tool-call assembly (ADR 0001). OpenAI and Anthropic both
 * stream a tool call as a name (once) plus argument-string fragments keyed by a
 * block index; this collects those fragments and parses the final JSON. Google
 * sends whole function-call objects and doesn't use this.
 */
import type { ToolCall } from '../shared/types';

/** One streamed fragment of a tool call. */
export interface ToolCallDelta {
  index: number;
  name?: string;
  argsFragment?: string;
}

export type ToolAcc = Map<number, { name: string; args: string }>;

/** Fold a chunk's fragments into the accumulator (name set once, args appended). */
export function accumulateToolDeltas(acc: ToolAcc, frags: readonly ToolCallDelta[]): void {
  for (const f of frags) {
    const e = acc.get(f.index) ?? { name: '', args: '' };
    if (f.name) e.name = f.name;
    if (f.argsFragment) e.args += f.argsFragment;
    acc.set(f.index, e);
  }
}

/** Reassemble accumulated fragments into normalized ToolCall[]. */
export function assembleToolCalls(acc: ToolAcc): ToolCall[] {
  return [...acc.values()]
    .filter((e) => e.name)
    .map((e) => {
      try {
        return { name: e.name, arguments: JSON.parse(e.args || '{}') };
      } catch {
        return { name: e.name, arguments: undefined, rawArguments: e.args };
      }
    });
}
