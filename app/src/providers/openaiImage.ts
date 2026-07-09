/**
 * OpenAI image-generation adapter (ADR 0007) — the first real MediaGenerator
 * backend. Non-streaming: POST /v1/images/generations, read the JSON, decode the
 * returned base64 images to bytes. Injected fetch/clock keep it testable without
 * network. A content-policy refusal is surfaced as `safetyBlocked` (not a throw),
 * because "the model refused" is a legitimate eval outcome the image pack gates on;
 * other non-OK statuses throw ProviderError like the chat adapters.
 */
import type { ChatCallOptions, FetchLike } from './types';
import { ProviderError, defaultFetch } from './types';
import type { Timing } from '../shared/types';

const ENDPOINT = 'https://api.openai.com/v1/images/generations';

export interface ImageGenRequest {
  readonly model: string;
  readonly prompt: string;
  /** How many images to generate (default 1). */
  readonly n?: number;
  /** Size string, e.g. "1024x1024"; omitted → model default. */
  readonly size?: string;
}

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

export interface ImageGenOutput {
  readonly images: readonly GeneratedImage[];
  readonly format: string;
  readonly safetyBlocked: boolean;
  readonly timing: Timing;
}

/** OpenAI error bodies flag a moderation refusal with these codes/types. */
function isSafetyRefusal(body: string): boolean {
  return /content_policy|moderation_blocked|safety/i.test(body);
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface ImageApiJson {
  data?: Array<{ b64_json?: string; url?: string }>;
  output_format?: string;
}

/** Fetch bytes for a data item that returned a URL instead of inline base64. */
async function bytesFromUrl(url: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<GeneratedImage> {
  const res = await fetchImpl(url, { method: 'GET', headers: {}, ...(signal ? { signal } : {}) });
  if (!res.ok) throw new ProviderError('openai', res.status, `image URL fetch failed`);
  const buf = decodeBase64(btoa(await res.text()));
  const mime = res.headers?.get('content-type') ?? 'image/png';
  return { bytes: buf, mime };
}

export async function generateOpenAIImage(req: ImageGenRequest, opts: ChatCallOptions): Promise<ImageGenOutput> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const clock = opts.clock ?? (() => Date.now());
  const start = clock();
  const body = JSON.stringify({
    model: req.model,
    prompt: req.prompt,
    n: req.n ?? 1,
    ...(req.size ? { size: req.size } : {}),
  });
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const raw = await res.text();
  const elapsed = Math.max(0, clock() - start);
  const timing: Timing = { ttfbMs: elapsed, totalMs: elapsed, tokens: 0, tokensPerSec: 0 };

  if (!res.ok) {
    if (isSafetyRefusal(raw)) return { images: [], format: 'none', safetyBlocked: true, timing };
    throw new ProviderError('openai', res.status, raw, req.model);
  }
  const json = JSON.parse(raw) as ImageApiJson;
  const format = json.output_format ?? 'png';
  const mime = `image/${format}`;
  const items = json.data ?? [];
  const images: GeneratedImage[] = [];
  for (const item of items) {
    if (item.b64_json) images.push({ bytes: decodeBase64(item.b64_json), mime });
    else if (item.url) images.push(await bytesFromUrl(item.url, fetchImpl, opts.signal));
  }
  return { images, format, safetyBlocked: false, timing };
}
