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

export async function* iterateSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
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
    // Flush any trailing line with no terminating newline.
    const tail = extractData(buffer.replace(/\r$/, ''));
    if (tail !== null && tail !== DONE) yield tail;
  } finally {
    reader.releaseLock();
  }
}
