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

/**
 * Reassemble accumulated fragments into normalized ToolCall[], ordered by the
 * provider-reported block `index`. Map-insertion order can diverge from index
 * order when fragments arrive interleaved, which breaks positional
 * correspondence — so sort by index (numeric ascending) before emitting.
 * Entries with a non-finite index sort stably after well-defined ones.
 */
export function assembleToolCalls(acc: ToolAcc): ToolCall[] {
  const indexFallback = (i: number) => (Number.isFinite(i) ? i : Number.POSITIVE_INFINITY);
  return [...acc.entries()]
    .sort(([a], [b]) => indexFallback(a) - indexFallback(b))
    .map(([, e]) => e)
    .filter((e) => e.name)
    .map((e) => {
      try {
        return { name: e.name, arguments: JSON.parse(e.args || '{}') };
      } catch {
        return { name: e.name, arguments: undefined, rawArguments: e.args };
      }
    });
}
