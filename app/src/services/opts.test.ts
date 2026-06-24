import { describe, it, expect } from 'vitest';
import { chatOptions } from './opts';

describe('chatOptions', () => {
  it('should pass through just the api key when nothing else is set', () => {
    const o = chatOptions({ apiKey: 'sk' });
    expect(o.apiKey).toBe('sk');
    expect(o.fetchImpl).toBeUndefined();
    expect(o.clock).toBeUndefined();
    expect(o.signal).toBeUndefined();
  });
  it('should carry fetchImpl, clock, and signal when provided', () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, body: null, text: async () => '' })) as never;
    const clock = () => 1;
    const signal = new AbortController().signal;
    const o = chatOptions({ apiKey: 'sk', fetchImpl, clock, signal });
    expect(o.fetchImpl).toBe(fetchImpl);
    expect(o.clock).toBe(clock);
    expect(o.signal).toBe(signal);
  });
});
