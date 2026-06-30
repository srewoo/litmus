/**
 * Generic Server-Sent-Events line reader. Yields the payload after each `data:`
 * field and stops at the `[DONE]` sentinel. Buffers across chunk boundaries so a
 * frame split mid-line is reassembled. Reused by every streaming provider adapter.
 */

const DONE = '[DONE]';

function extractData(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  return line.slice(5).trim();
}

export async function* iterateSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cancelled = false;
  // Cancel the reader at most once (early consumer return, abort, or error all
  // route through the finally; a double cancel on an already-released reader throws).
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel();
  };
  // Abort mid-stream: cancel the underlying stream so the pending read() rejects
  // and the loop terminates instead of hanging on a never-resolving read.
  const onAbort = (): void => cancel();
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    for (;;) {
      if (signal?.aborted) break;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        // read() rejects when the stream is cancelled (e.g. on abort) — stop.
        break;
      }
      const { value, done } = result;
      if (done) break;
      if (signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        const payload = extractData(line);
        if (payload === DONE) return;
        if (payload !== null) yield payload;
        nl = buffer.indexOf('\n');
      }
    }
    // Flush any buffered trailing multi-byte char left in the decoder, then the
    // remaining unterminated line (no newline). Skip if we were aborted.
    if (!signal?.aborted) {
      buffer += decoder.decode();
      const tail = extractData(buffer.replace(/\r$/, ''));
      if (tail !== null && tail !== DONE) yield tail;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    // Cancel the stream on early consumer return / abort so the connection isn't
    // leaked, then release the lock.
    cancel();
    reader.releaseLock();
  }
}
