import { describe, it, expect } from 'vitest';
import { describeOpenAIImage } from './openaiVision';
import type { FetchLike, FetchResponse } from './types';
import { ProviderError } from './types';

function response(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Wrap a JSON content string the way chat/completions nests it. */
function completion(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

const bytes = new Uint8Array([1, 2, 3, 4]);

describe('describeOpenAIImage', () => {
  it('should send a data-URL image and parse labels + ocrText', async () => {
    let sent: string = '';
    const fetchImpl: FetchLike = async (url, init) => {
      sent = init.body ?? '';
      expect(url).toMatch(/chat\/completions/);
      return response(200, completion('{"labels":["a red cube","table"],"ocrText":"SALE"}'));
    };
    const out = await describeOpenAIImage(bytes, 'image/png', { apiKey: 'sk', model: 'gpt-4o', fetchImpl });
    expect(out.labels).toEqual(['a red cube', 'table']);
    expect(out.ocrText).toBe('SALE');
    // The image is embedded as a base64 data URL in the request.
    expect(sent).toMatch(/data:image\/png;base64,/);
    expect(JSON.parse(sent).response_format).toEqual({ type: 'json_object' });
  });

  it('should default missing fields to empty', async () => {
    const fetchImpl: FetchLike = async () => response(200, completion('{"labels":["x"]}'));
    const out = await describeOpenAIImage(bytes, 'image/png', { apiKey: 'sk', model: 'gpt-4o', fetchImpl });
    expect(out.labels).toEqual(['x']);
    expect(out.ocrText).toBe('');
  });

  it('should degrade to empty on unparseable content (never break a run)', async () => {
    const fetchImpl: FetchLike = async () => response(200, completion('not json'));
    const out = await describeOpenAIImage(bytes, 'image/png', { apiKey: 'sk', model: 'gpt-4o', fetchImpl });
    expect(out).toEqual({ labels: [], ocrText: '' });
  });

  it('should degrade to empty when the response has no choices/content', async () => {
    const fetchImpl: FetchLike = async () => response(200, { choices: [] });
    const out = await describeOpenAIImage(bytes, 'image/png', { apiKey: 'sk', model: 'gpt-4o', fetchImpl });
    expect(out).toEqual({ labels: [], ocrText: '' });
  });

  it('should forward an abort signal on the request', async () => {
    let sawSignal = false;
    const fetchImpl: FetchLike = async (_u, init) => {
      sawSignal = init.signal !== undefined;
      return response(200, completion('{"labels":[],"ocrText":""}'));
    };
    const ac = new AbortController();
    await describeOpenAIImage(bytes, 'image/png', { apiKey: 'sk', model: 'gpt-4o', fetchImpl, signal: ac.signal });
    expect(sawSignal).toBe(true);
  });

  it('should throw ProviderError on an HTTP failure', async () => {
    const fetchImpl: FetchLike = async () => response(401, { error: { message: 'bad key' } });
    await expect(
      describeOpenAIImage(bytes, 'image/png', { apiKey: 'sk', model: 'gpt-4o', fetchImpl }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
