import { describe, it, expect } from 'vitest';
import type { StorageArea } from './storage';
import type { PromptVersion } from '../shared/types';
import type { RunRecord } from './store';
import { SessionTabStore, versionKeyForTab, VERSION_KEY_PREFIX } from './sessionTabStore';

class InMemoryStorageArea implements StorageArea {
  readonly store = new Map<string, unknown>();
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

const version = (id: string, index: number): PromptVersion => ({
  id,
  index,
  text: `prompt ${index}`,
  createdAt: index,
  parentId: null,
  note: 'baseline',
});

const run = (versionId: string, overall: number): RunRecord => ({
  versionId,
  summary: { overall, passCount: 1, failCount: 0, total: 1, speed: { ttfbMs: 1, avgResponseMs: 1, tokensPerSec: 1 } },
  results: [],
  createdAt: 1,
});

const storeFor = (area: StorageArea, tabId: number) =>
  new SessionTabStore(area, async () => versionKeyForTab(tabId));

describe('versionKeyForTab', () => {
  it('should namespace by tab id and fall back when unknown', () => {
    expect(versionKeyForTab(7)).toBe(`${VERSION_KEY_PREFIX}7`);
    expect(versionKeyForTab(undefined)).toBe(`${VERSION_KEY_PREFIX}panel`);
  });
});

describe('SessionTabStore', () => {
  it('should return no versions for a fresh tab', async () => {
    const store = storeFor(new InMemoryStorageArea(), 1);
    expect(await store.getVersions()).toEqual([]);
    expect(await store.getRun('v1')).toBeNull();
  });

  it('should persist versions and runs and sort versions by index', async () => {
    const store = storeFor(new InMemoryStorageArea(), 1);
    await store.putVersion(version('v2', 2));
    await store.putVersion(version('v1', 1));
    await store.putRun(run('v1', 8.4));

    const versions = await store.getVersions();
    expect(versions.map((v) => v.id)).toEqual(['v1', 'v2']);
    expect((await store.getRun('v1'))?.summary.overall).toBe(8.4);
  });

  it('should upsert a version by id rather than duplicate it', async () => {
    const store = storeFor(new InMemoryStorageArea(), 1);
    await store.putVersion(version('v1', 1));
    await store.putVersion({ ...version('v1', 1), note: 'edited prompt' });
    const versions = await store.getVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.note).toBe('edited prompt');
  });

  it('should isolate history between tabs sharing one storage area', async () => {
    const area = new InMemoryStorageArea();
    const tabA = storeFor(area, 1);
    const tabB = storeFor(area, 2);

    await tabA.putVersion(version('v1', 1));

    expect(await tabA.getVersions()).toHaveLength(1);
    // A different tab sees its own (empty) namespace — the crux of "tab-specific".
    expect(await tabB.getVersions()).toEqual([]);
  });

  it('should not lose writes when two mutations run concurrently', async () => {
    // Storage area whose get/set resolve on a microtask so two read-modify-write
    // ops genuinely interleave — without serialization the second read would see
    // the pre-write blob and clobber the first write (the P0 lost-update race).
    class SlowStorageArea implements StorageArea {
      readonly store = new Map<string, unknown>();
      async get(keys: string | string[]): Promise<Record<string, unknown>> {
        await Promise.resolve();
        const arr = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of arr) if (this.store.has(k)) out[k] = this.store.get(k);
        return out;
      }
      async set(items: Record<string, unknown>): Promise<void> {
        await Promise.resolve();
        for (const [k, v] of Object.entries(items)) this.store.set(k, v);
      }
      async remove(keys: string | string[]): Promise<void> {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) this.store.delete(k);
      }
    }

    const store = storeFor(new SlowStorageArea(), 1);
    // Interleave two version writes and two run writes started together.
    await Promise.all([
      store.putVersion(version('v1', 1)),
      store.putVersion(version('v2', 2)),
      store.putRun(run('v1', 7)),
      store.putRun(run('v2', 9)),
    ]);

    const versions = await store.getVersions();
    expect(versions.map((v) => v.id)).toEqual(['v1', 'v2']);
    expect((await store.getRun('v1'))?.summary.overall).toBe(7);
    expect((await store.getRun('v2'))?.summary.overall).toBe(9);
  });

  it('should keep the mutation queue working after a failing mutation', async () => {
    let failNext = true;
    class FlakyStorageArea implements StorageArea {
      readonly store = new Map<string, unknown>();
      async get(keys: string | string[]): Promise<Record<string, unknown>> {
        await Promise.resolve();
        if (failNext) {
          failNext = false;
          throw new Error('transient read failure');
        }
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

    const store = storeFor(new FlakyStorageArea(), 1);
    // read() swallows errors and returns EMPTY, so the first op succeeds against
    // an empty blob; the key assertion is that the chain is not broken and the
    // second queued op still runs and persists.
    await store.putVersion(version('v1', 1));
    await store.putVersion(version('v2', 2));
    expect((await store.getVersions()).map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  it('should leave a tab empty again once its namespace key is removed (tab-close cleanup)', async () => {
    const area = new InMemoryStorageArea();
    const store = storeFor(area, 5);
    await store.putVersion(version('v1', 1));
    expect(await store.getVersions()).toHaveLength(1);

    // Simulate background.js chrome.tabs.onRemoved cleanup.
    await area.remove(versionKeyForTab(5));
    const fresh = storeFor(area, 5);
    expect(await fresh.getVersions()).toEqual([]);
  });
});
