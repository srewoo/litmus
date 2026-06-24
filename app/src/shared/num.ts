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

/** Arithmetic mean. Returns 0 for an empty list rather than NaN. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}
