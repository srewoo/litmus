import { describe, it, expect } from 'vitest';
import type { StorageArea } from './storage';
import { loadSnapshot, saveSnapshot, clearSnapshot } from './sessionCache';
import type { SessionSnapshot } from './sessionCache';

class InMemoryStorageArea implements StorageArea {
  private readonly store = new Map<string, unknown>();
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const arr = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of arr) if (this.store.has(k)) out[k] = this.store.get(k);
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.store.set(k, v);
  }
  async remove(keys: string | string[]): Promise<void> {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) this.store.delete(k);
  }
}

const snap: SessionSnapshot = {
  prompt: 'SYS',
  targetValue: 'openai/gpt-5-mini',
  analysis: null,
  dimensions: [{ name: 'accuracy', description: 'is it right' }],
  rubrics: { accuracy: 'RUBRIC TEXT' },
  activeDimension: 'accuracy',
  cases: [{ id: 'case-1', category: 'typical', input: 'hello', pinned: false }],
  tools: [],
  suiteKey: 'k1',
  casesKey: 'k1',
};

describe('session cache', () => {
  it('should return null when nothing is stored', async () => {
    expect(await loadSnapshot(new InMemoryStorageArea())).toBeNull();
  });

  it('should round-trip a snapshot', async () => {
    const area = new InMemoryStorageArea();
    await saveSnapshot(area, snap);
    expect(await loadSnapshot(area)).toEqual(snap);
  });

  it('should clear a stored snapshot', async () => {
    const area = new InMemoryStorageArea();
    await saveSnapshot(area, snap);
    await clearSnapshot(area);
    expect(await loadSnapshot(area)).toBeNull();
  });

  it('should reject a malformed snapshot rather than returning garbage', async () => {
    const area = new InMemoryStorageArea();
    await area.set({ 'litmus:session-cache': { prompt: 123, cases: 'nope' } });
    expect(await loadSnapshot(area)).toBeNull();
  });
});
