import { describe, it, expect } from 'vitest';
import { iterateSSE } from './sse';

function streamFrom(frames: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('iterateSSE', () => {
  it('should yield each data payload and stop at [DONE]', async () => {
    const payloads = await collect(
      iterateSSE(streamFrom(['data: a\n', 'data: b\n', 'data: [DONE]\n', 'data: c\n'])),
    );
    expect(payloads).toEqual(['a', 'b']);
  });

  it('should reassemble a payload split across chunk boundaries', async () => {
    const payloads = await collect(
      iterateSSE(streamFrom(['data: {"x":', '1}\n', 'data: [DONE]\n'])),
    );
    expect(payloads).toEqual(['{"x":1}']);
  });

  it('should ignore non-data lines and flush a trailing unterminated line', async () => {
    const payloads = await collect(iterateSSE(streamFrom([': keep-alive\n', 'data: last'])));
    expect(payloads).toEqual(['last']);
  });
});
