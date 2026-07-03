import { describe, it, expect } from 'vitest';
import { callJson } from './jsonCall';
import type { Provider, ChatRequest } from '../providers/types';
import type { Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };

function providerReturning(texts: string[]): { provider: Provider; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  const provider: Provider = {
    id: 'openai',
    async chat(req) {
      calls.push(req);
      return { text: texts[i++] ?? texts[texts.length - 1] ?? '', timing };
    },
  };
  return { provider, calls };
}

const opts = { apiKey: 'sk' };
const parse = (t: string): { ok: boolean } => JSON.parse(t) as { ok: boolean };

describe('callJson', () => {
  it('should return the parsed value on the first valid response', async () => {
    const { provider, calls } = providerReturning(['{"ok":true}']);
    expect(await callJson(provider, { model: 'm', messages: [] }, opts, parse)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('should retry once with a corrective nudge after a parse failure', async () => {
    const { provider, calls } = providerReturning(['not json', '{"ok":true}']);
    const result = await callJson(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, opts, parse);
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    // the retry appends the failed assistant turn AND the corrective nudge, so
    // the model can see what it produced and no two user turns sit adjacent.
    const retryMsgs = calls[1]?.messages ?? [];
    expect(retryMsgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(retryMsgs[1]).toMatchObject({ role: 'assistant', content: 'not json' });
    expect(retryMsgs[2]?.content).toContain('valid JSON');
  });

  it('should throw after exhausting retries', async () => {
    const { provider, calls } = providerReturning(['bad', 'still bad']);
    await expect(callJson(provider, { model: 'm', messages: [] }, opts, parse)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it('should wrap a non-Error parser throw', async () => {
    const { provider } = providerReturning(['x', 'y']);
    const parseThrowsString = (): never => {
      throw 'not an error object';
    };
    await expect(callJson(provider, { model: 'm', messages: [] }, opts, parseThrowsString)).rejects.toThrow(
      'parse failed after retries',
    );
  });
});
