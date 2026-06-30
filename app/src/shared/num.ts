/** Pure numeric helpers. Kept tiny and dependency-free so every layer can reuse them. */

/** Round to one decimal place (the precision litmus shows scores and seconds in). */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Clamp a number into an inclusive range. */
export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Coerce a value into a positive integer count (>= 1), used for repeat counts
 * like `samples` / `judgeSamples`. Non-finite (NaN, ±Infinity) and sub-1 values
 * collapse to 1 — so a degenerate count can never hang a loop (`s < Infinity`),
 * throw on `Array.from({ length: NaN })`, or silently run zero times. Valid
 * finite inputs are unchanged (floored), so this only tightens the bad edges.
 */
export function positiveCount(n: number): number {
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}

/** Arithmetic mean. Returns 0 for an empty list rather than NaN. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}
