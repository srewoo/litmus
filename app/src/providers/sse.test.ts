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

  it('should flush a trailing multi-byte char buffered across the decoder', async () => {
    // 'é' (U+00E9) is two UTF-8 bytes; split them across two chunks with no newline.
    const bytes = new TextEncoder().encode('data: é');
    const head = bytes.slice(0, bytes.length - 1);
    const tail = bytes.slice(bytes.length - 1);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(head);
        c.enqueue(tail);
        c.close();
      },
    });
    expect(await collect(iterateSSE(stream))).toEqual(['é']);
  });

  it('should terminate the iteration and cancel the reader when the signal aborts', async () => {
    let cancelled = false;
    // A stream that emits one frame then stalls forever — only an abort/cancel ends it.
    const enc = new TextEncoder();
    const ac = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: a\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    const seen: string[] = [];
    const iter = iterateSSE(stream, ac.signal);
    const drain = (async () => {
      for await (const x of iter) {
        seen.push(x);
        ac.abort(); // abort after the first payload
      }
    })();

    await drain; // must resolve (not hang) once aborted
    expect(seen).toEqual(['a']);
    expect(cancelled).toBe(true);
  });

  it('should not yield when the signal is already aborted before reading', async () => {
    const ac = new AbortController();
    ac.abort();
    const payloads = await collect(iterateSSE(streamFrom(['data: a\n', 'data: b\n']), ac.signal));
    expect(payloads).toEqual([]);
  });

  it('should cancel the stream when the consumer returns early', async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: a\n'));
        c.enqueue(enc.encode('data: b\n'));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const x of iterateSSE(stream)) {
      expect(x).toBe('a');
      break; // early return triggers the generator's finally
    }
    expect(cancelled).toBe(true);
  });
});
