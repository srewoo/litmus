/**
 * OpenAI vision describer (ADR 0007) — an injectable ImageDescriber checker
 * backend. Sends a generated image to a vision-capable chat model and asks for
 * structured content signals: the concrete elements present (labels) and any text
 * rendered in the image (OCR). This is what lights up the image pack's
 * `mustContain` / `text` content checks. Non-streaming JSON output, injected
 * fetch/clock, so it's testable without network. HTTP failures throw
 * ProviderError like the other adapters; the caller decides whether to degrade.
 */
import { z } from 'zod';
import type { ChatCallOptions } from './types';
import { ProviderError, defaultFetch } from './types';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT =
  'You are a precise vision analyst. Respond with JSON only: ' +
  '{"labels": string[], "ocrText": string}. `labels` lists the concrete objects and visual ' +
  'elements actually visible in the image (lowercase noun phrases). `ocrText` is all text ' +
  'rendered in the image, verbatim, or "" if none. Do not infer or add anything not visible.';

export interface VisionDescription {
  readonly labels: readonly string[];
  readonly ocrText: string;
}

const VisionSchema = z.object({
  labels: z.array(z.string()).default([]),
  ocrText: z.string().default(''),
});

export interface DescribeOptions extends ChatCallOptions {
  /** Vision-capable chat model id (e.g. gpt-4o, gpt-5.1). */
  readonly model: string;
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export async function describeOpenAIImage(
  bytes: Uint8Array,
  mime: string,
  opts: DescribeOptions,
): Promise<VisionDescription> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const dataUrl = `data:${mime};base64,${encodeBase64(bytes)}`;
  const body = JSON.stringify({
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image as instructed.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  });
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const raw = await res.text();
  if (!res.ok) throw new ProviderError('openai', res.status, raw, opts.model);
  const content = (JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message
    ?.content;
  // The model's content is itself JSON; a malformed/empty body degrades to empty
  // content signals rather than throwing — a describer hiccup must never fail the run.
  try {
    const parsed = VisionSchema.safeParse(JSON.parse(content ?? '{}'));
    return parsed.success ? parsed.data : { labels: [], ocrText: '' };
  } catch {
    return { labels: [], ocrText: '' };
  }
}
