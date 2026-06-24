import { describe, it, expect } from 'vitest';
import { estimateTokens, finalizeTiming, aggregateSpeed } from './timing';
import type { Timing } from '../shared/types';

describe('estimateTokens', () => {
  it('should estimate ~4 chars per token', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });
  it('should never return less than 1 for non-empty-ish text', () => {
    expect(estimateTokens('')).toBe(1);
  });
});

describe('finalizeTiming', () => {
  it('should compute tokens/sec from provider-reported tokens', () => {
    const t = finalizeTiming({ ttfbMs: 100, totalMs: 2000, text: 'x'.repeat(40) }, 200);
    expect(t.tokens).toBe(200);
    expect(t.tokensPerSec).toBe(100); // 200 tokens / 2s
  });
  it('should fall back to estimated tokens when usage is absent', () => {
    const t = finalizeTiming({ ttfbMs: 50, totalMs: 1000, text: 'x'.repeat(40) });
    expect(t.tokens).toBe(10); // 40 chars / 4
    expect(t.tokensPerSec).toBe(10);
  });
  it('should avoid divide-by-zero for an instantaneous response', () => {
    const t = finalizeTiming({ ttfbMs: 0, totalMs: 0, text: 'abcd' }, 1);
    expect(t.tokensPerSec).toBe(0);
  });
});

describe('aggregateSpeed', () => {
  const mk = (ttfbMs: number, totalMs: number, tokens: number): Timing => ({
    ttfbMs,
    totalMs,
    tokens,
    tokensPerSec: 0,
  });

  it('should return zeros for an empty run', () => {
    expect(aggregateSpeed([])).toEqual({ ttfbMs: 0, avgResponseMs: 0, tokensPerSec: 0 });
  });

  it('should mean the TTFB and response times and weight tokens/sec by run total', () => {
    const agg = aggregateSpeed([mk(100, 1000, 50), mk(300, 3000, 150)]);
    expect(agg.ttfbMs).toBe(200); // mean(100,300)
    expect(agg.avgResponseMs).toBe(2000); // mean(1000,3000)
    expect(agg.tokensPerSec).toBe(50); // 200 tokens / 4s total
  });
});
