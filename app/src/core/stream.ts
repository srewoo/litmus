/**
 * Streaming-timing capture — the M0 risk the PRD calls out (§11, §15):
 * can we measure TTFB and total response time from a streamed provider
 * response, in-browser, accurately?
 *
 * Pure logic with an injected clock, so it is deterministic and unit-testable
 * without any network. Provider adapters decode their SSE/JSON wire format into
 * a plain string chunk stream and hand it to `timeChunkStream`.
 */

/** Injected time source (ms). Real code passes `() => performance.now()`. */
export type Clock = () => number;

export interface StreamMeasurement {
  /** ms from `startMs` to the first non-empty chunk. */
  readonly ttfbMs: number;
  /** ms from `startMs` to stream end. */
  readonly totalMs: number;
  readonly text: string;
}

/**
 * Consume a stream of text deltas, recording when the first one arrives
 * (TTFB) and when the stream completes (total). Empty chunks are ignored
 * for TTFB but still counted toward completion.
 */
export async function timeChunkStream(
  chunks: AsyncIterable<string>,
  startMs: number,
  clock: Clock,
): Promise<StreamMeasurement> {
  let firstByteAt: number | null = null;
  let text = '';

  for await (const chunk of chunks) {
    if (chunk.length > 0 && firstByteAt === null) {
      firstByteAt = clock() - startMs;
    }
    text += chunk;
  }

  const totalMs = clock() - startMs;
  return { ttfbMs: firstByteAt ?? totalMs, totalMs, text };
}
