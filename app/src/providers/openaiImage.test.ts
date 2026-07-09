import { describe, it, expect } from 'vitest';
import { generateOpenAIImage } from './openaiImage';
import type { FetchLike, FetchResponse } from './types';
import { ProviderError } from './types';

const PNG_B64 = btoa('\x89PNG\r\n\x1a\nfakepngbytes');

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    headers: { get: (n: string) => headers?.[n.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const clock = (() => {
  let t = 0;
  return () => (t += 100);
})();

describe('generateOpenAIImage', () => {
  it('should POST the prompt and decode inline base64 images', async () => {
    let seen: { url: string; body: string } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, body: init.body ?? '' };
      return jsonResponse(200, { data: [{ b64_json: PNG_B64 }], output_format: 'png' });
    };
    const out = await generateOpenAIImage(
      { model: 'gpt-image-1', prompt: 'a red cube', n: 1, size: '512x512' },
      { apiKey: 'sk-x', fetchImpl, clock },
    );
    expect(out.images).toHaveLength(1);
    expect(out.images[0]?.mime).toBe('image/png');
    expect(out.images[0]?.bytes.length).toBeGreaterThan(0);
    expect(out.safetyBlocked).toBe(false);
    expect(out.timing.totalMs).toBeGreaterThan(0);
    expect(seen!.url).toMatch(/images\/generations/);
    expect(JSON.parse(seen!.body)).toMatchObject({ model: 'gpt-image-1', prompt: 'a red cube', n: 1, size: '512x512' });
  });

  it('should mark a content-policy refusal as safetyBlocked, not throw', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(400, { error: { code: 'content_policy_violation', message: 'blocked' } });
    const out = await generateOpenAIImage({ model: 'gpt-image-1', prompt: 'x' }, { apiKey: 'sk', fetchImpl, clock });
    expect(out.safetyBlocked).toBe(true);
    expect(out.images).toHaveLength(0);
  });

  it('should throw ProviderError on a non-safety error status', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, { error: { message: 'bad key' } });
    await expect(
      generateOpenAIImage({ model: 'gpt-image-1', prompt: 'x' }, { apiKey: 'sk', fetchImpl, clock }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('should fetch bytes when a data item returns a URL instead of base64', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('images/generations')) return jsonResponse(200, { data: [{ url: 'https://cdn/img.png' }] });
      return jsonResponse(200, 'rawbytes', { 'content-type': 'image/jpeg' });
    };
    const out = await generateOpenAIImage({ model: 'gpt-image-1', prompt: 'x' }, { apiKey: 'sk', fetchImpl, clock });
    expect(out.images).toHaveLength(1);
    expect(out.images[0]?.mime).toBe('image/jpeg');
  });

  it('should throw when a returned image URL fails to fetch', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('images/generations')) return jsonResponse(200, { data: [{ url: 'https://cdn/x.png' }] });
      return jsonResponse(404, 'not found');
    };
    await expect(
      generateOpenAIImage({ model: 'gpt-image-1', prompt: 'x' }, { apiKey: 'sk', fetchImpl, clock }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('should default a URL image mime to png when no content-type is present', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('images/generations')) return jsonResponse(200, { data: [{ url: 'https://cdn/x' }] });
      return jsonResponse(200, 'bytes'); // no content-type header
    };
    const out = await generateOpenAIImage({ model: 'gpt-image-1', prompt: 'x' }, { apiKey: 'sk', fetchImpl, clock });
    expect(out.images[0]?.mime).toBe('image/png');
  });

  it('should work with the default clock when none is injected', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { data: [{ b64_json: PNG_B64 }] });
    const out = await generateOpenAIImage({ model: 'gpt-image-1', prompt: 'x' }, { apiKey: 'sk', fetchImpl });
    expect(out.images).toHaveLength(1);
    expect(out.timing.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('should default n to 1 and omit size when not given', async () => {
    let body = '';
    const fetchImpl: FetchLike = async (_u, init) => {
      body = init.body ?? '';
      return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] });
    };
    await generateOpenAIImage({ model: 'gpt-image-1', prompt: 'x' }, { apiKey: 'sk', fetchImpl, clock });
    const parsed = JSON.parse(body);
    expect(parsed.n).toBe(1);
    expect('size' in parsed).toBe(false);
  });
});
