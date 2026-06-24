import { describe, it, expect } from 'vitest';
import { timeChunkStream } from './stream';

function fakeClock(sequence: readonly number[]): () => number {
  let i = 0;
  return () => sequence[i++] ?? sequence[sequence.length - 1] ?? 0;
}

async function* gen(items: readonly string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

describe('timeChunkStream', () => {
  it('should record TTFB at the first chunk and total at stream end', async () => {
    const m = await timeChunkStream(gen(['Hel', 'lo']), 1000, fakeClock([1150, 1800]));
    expect(m.ttfbMs).toBe(150);
    expect(m.totalMs).toBe(800);
    expect(m.text).toBe('Hello');
  });

  it('should ignore leading empty chunks for TTFB', async () => {
    const m = await timeChunkStream(gen(['', 'hi']), 1000, fakeClock([1200, 1500]));
    expect(m.ttfbMs).toBe(200);
    expect(m.totalMs).toBe(500);
    expect(m.text).toBe('hi');
  });

  it('should collapse TTFB to total when the stream is empty', async () => {
    const m = await timeChunkStream(gen([]), 1000, fakeClock([1500]));
    expect(m.ttfbMs).toBe(500);
    expect(m.totalMs).toBe(500);
    expect(m.text).toBe('');
  });
});
