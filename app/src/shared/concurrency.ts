/**
 * Bounded-concurrency map. Runs `fn` over `items` with at most `limit` in flight
 * at once (a worker pool, not fixed waves — a new item starts the moment a slot
 * frees), preserving input order in the result. Used to fan out MCP batch tool
 * calls (up to 10 inputs, 5 concurrent). A rejected `fn` rejects the whole map;
 * callers that want per-item errors should resolve to a result object instead.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  // A NaN limit would make `Math.min(cap, n)` NaN → zero workers → the map
  // silently returns a sparse array of holes. Guard it to sequential. A finite
  // limit is floored to >= 1; Infinity is preserved (capped to `n` below = run
  // all at once), which is its intended "unbounded" meaning.
  const cap = Number.isNaN(limit) ? 1 : Math.max(1, Math.floor(limit));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(cap, n) }, () => worker()));
  return results;
}
