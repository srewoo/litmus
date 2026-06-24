/** Turn a raw stream measurement into a domain Timing, and aggregate timings across a run. */
import type { SpeedAggregate, Timing } from '../shared/types';
import type { StreamMeasurement } from './stream';
import { mean, round1 } from '../shared/num';

/** Rough token estimate when a provider doesn't return a usage count (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Finalize a single call's timing. Uses provider-reported `tokens` when available, else estimates. */
export function finalizeTiming(m: StreamMeasurement, tokens?: number): Timing {
  const tk = tokens ?? estimateTokens(m.text);
  const seconds = m.totalMs / 1000;
  const tokensPerSec = seconds > 0 ? tk / seconds : 0;
  return {
    ttfbMs: round1(m.ttfbMs),
    totalMs: round1(m.totalMs),
    tokens: tk,
    tokensPerSec: Math.round(tokensPerSec),
  };
}

/**
 * Aggregate per-case timings into the run-level speed strip.
 * TTFB and response time are means; tokens/sec is computed over the run total
 * (sum of tokens over sum of seconds) so long cases are weighted fairly.
 */
export function aggregateSpeed(timings: readonly Timing[]): SpeedAggregate {
  if (timings.length === 0) {
    return { ttfbMs: 0, avgResponseMs: 0, tokensPerSec: 0 };
  }
  const totalTokens = timings.reduce((acc, t) => acc + t.tokens, 0);
  const totalSeconds = timings.reduce((acc, t) => acc + t.totalMs, 0) / 1000;
  return {
    ttfbMs: round1(mean(timings.map((t) => t.ttfbMs))),
    avgResponseMs: round1(mean(timings.map((t) => t.totalMs))),
    tokensPerSec: totalSeconds > 0 ? Math.round(totalTokens / totalSeconds) : 0,
  };
}
