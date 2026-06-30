import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 5, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 5, async (n) => n)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n)).toEqual([1, 2]);
  });

  it('passes the index to fn', async () => {
    const out = await mapWithConcurrency(['a', 'b', 'c'], 2, async (v, i) => `${i}:${v}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });

  it('treats a NaN limit as sequential instead of silently returning holes', async () => {
    const out = await mapWithConcurrency([1, 2, 3], Number.NaN, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]); // every item ran; no `undefined` holes
  });

  it('floors a fractional or sub-1 limit up to a single worker', async () => {
    expect(await mapWithConcurrency([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
    expect(await mapWithConcurrency([1, 2, 3], -4, async (n) => n)).toEqual([1, 2, 3]);
    expect(await mapWithConcurrency([1, 2, 3], 1.9, async (n) => n)).toEqual([1, 2, 3]);
  });

  it('treats an Infinity limit as unbounded (runs every item at once)', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 6 }, (_, i) => i);
    await mapWithConcurrency(items, Number.POSITIVE_INFINITY, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBe(items.length); // all in flight together
  });

  it('rejects the whole map when fn rejects (documented contract)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
