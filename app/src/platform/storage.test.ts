import { describe, it, expect } from 'vitest';
import type { StorageArea } from './storage';
import { loadSettings, setKey, getKey, deleteAllKeys } from './storage';

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

describe('settings storage', () => {
  it('should return defaults when nothing is stored', async () => {
    const s = await loadSettings(new InMemoryStorageArea());
    expect(s.keys).toEqual({});
    expect(s.passThreshold).toBe(6);
  });

  it('should round-trip a provider key', async () => {
    const area = new InMemoryStorageArea();
    await setKey(area, 'openai', 'sk-abc');
    expect(await getKey(area, 'openai')).toBe('sk-abc');
    expect(await getKey(area, 'anthropic')).toBeUndefined();
  });

  it('should reject an empty key', async () => {
    const area = new InMemoryStorageArea();
    await expect(setKey(area, 'openai', '')).rejects.toThrow();
  });

  it('should fall back to defaults when stored settings are corrupt instead of throwing', async () => {
    const area = new InMemoryStorageArea();
    // Schema-drifted / corrupt blob: passThreshold out of range and keys the
    // wrong type. parse() would throw and hard-brick the panel; loadSettings
    // must return sane defaults instead.
    await area.set({ 'litmus:settings': { passThreshold: 99, keys: 'not-an-object', samples: -3 } });

    const s = await loadSettings(area);
    expect(s.keys).toEqual({});
    expect(s.passThreshold).toBe(6);
    expect(s.samples).toBe(1);
  });

  it('should clear all keys but keep other settings', async () => {
    const area = new InMemoryStorageArea();
    await setKey(area, 'openai', 'sk-abc');
    const after = await deleteAllKeys(area);
    expect(after.keys).toEqual({});
    expect(after.passThreshold).toBe(6);
  });
});
