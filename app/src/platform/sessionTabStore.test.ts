import { describe, it, expect } from 'vitest';
import type { StorageArea } from './storage';
import type { PromptVersion } from '../shared/types';
import type { RunRecord } from './store';
import { SessionTabStore, versionKeyForTab, VERSION_KEY_PREFIX } from './sessionTabStore';
import { QuotaExceededError } from './store';

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

  it('appendVersion should allocate distinct sequential indexes under concurrent calls', async () => {
    const store = storeFor(new InMemoryStorageArea(), 1);
    // Fire 4 appends without awaiting between them — the mutation queue must
    // serialize the read→allocate→write so no two share an index/id.
    const built = await Promise.all(
      Array.from({ length: 4 }, () => store.appendVersion((index) => version(`v${index}`, index))),
    );
    expect(built.map((v) => v.index).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    const stored = await store.getVersions();
    expect(stored.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
  });

  it('should stamp the schema version on every write (ADR 0004)', async () => {
    const area = new InMemoryStorageArea();
    const store = storeFor(area, 1);
    await store.putVersion(version('v1', 1));
    const blob = area.store.get(versionKeyForTab(1)) as { schemaVersion?: number };
    expect(blob.schemaVersion).toBe(1);
  });

  it('should tolerantly read a legacy blob that has no schemaVersion (no data loss)', async () => {
    const area = new InMemoryStorageArea();
    // Simulate data written by a pre-ADR-0004 build: versions/runs, no schemaVersion.
    await area.set({ [versionKeyForTab(1)]: { versions: [version('v1', 1)], runs: { v1: run('v1', 8) } } });
    const store = storeFor(area, 1);
    expect(await store.getVersions()).toHaveLength(1);
    expect((await store.getRun('v1'))?.summary.overall).toBe(8);
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
    // The first op's pre-read throws → it REJECTS and writes nothing (Fix 2: a
    // write critical section no longer swallows a storage error and clobbers
    // good data with EMPTY). The queue tail must still advance so the next op
    // runs and persists — that's the resilience property under test.
    await expect(store.putVersion(version('v1', 1))).rejects.toThrow('transient read failure');
    await store.putVersion(version('v2', 2));
    expect((await store.getVersions()).map((v) => v.id)).toEqual(['v2']);
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

  it('merge-on-write should not clobber another window that committed between our start-read and write', async () => {
    // Two side panels in different windows share ONE durable key. Window A takes
    // its start-of-op snapshot while the store is EMPTY (the stale-snapshot bug
    // trigger — old code would then write [a] and erase window B's data). Before
    // A's merge re-read, window B commits its own version+run. Merge-on-write
    // must observe B and preserve it, bumping A's colliding index so BOTH
    // versions and BOTH runs survive.
    const key = versionKeyForTab(1);
    let getCount = 0;
    class RaceArea implements StorageArea {
      readonly store = new Map<string, unknown>();
      async get(keys: string | string[]): Promise<Record<string, unknown>> {
        const idx = getCount++;
        // Between A's start-read (idx 0) and A's merge re-read (idx 1), window B
        // commits {b@1 + run}. Its computed index 1 collides with A's index 1.
        if (idx === 1) {
          this.store.set(key, {
            schemaVersion: 1,
            versions: [version('b', 1)],
            runs: { b: run('b', 9) },
          });
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
    const store = new SessionTabStore(new RaceArea(), async () => key);

    const va = await store.appendVersion((index) => version('a', index));
    await store.putRun(run('a', 5));

    // A's index collided with B's index 1 and was bumped so both survive distinctly.
    expect(va.index).toBe(2);
    const versions = await store.getVersions();
    expect(versions.map((v) => v.id)).toEqual(['b', 'a']);
    expect(new Set(versions.map((v) => v.index)).size).toBe(2);
    // BOTH runs survive the additive merge.
    expect((await store.getRun('a'))?.summary.overall).toBe(5);
    expect((await store.getRun('b'))?.summary.overall).toBe(9);
  });

  it('appendVersion must reject and not write when its pre-read throws (no wipe with EMPTY)', async () => {
    const setCalls: Record<string, unknown>[] = [];
    class ThrowingReadArea implements StorageArea {
      async get(): Promise<Record<string, unknown>> {
        throw new Error('storage unavailable');
      }
      async set(items: Record<string, unknown>): Promise<void> {
        setCalls.push(items);
      }
      async remove(): Promise<void> {}
    }
    const store = new SessionTabStore(new ThrowingReadArea(), async () => versionKeyForTab(1));
    await expect(store.appendVersion((index) => version(`v${index}`, index))).rejects.toThrow('storage unavailable');
    // Critical: the failed pre-read must NOT lead to a set() that overwrites good data.
    expect(setCalls).toEqual([]);
  });

  it('should prune to the N most-recent runs, keeping all versions', async () => {
    const area = new InMemoryStorageArea();
    const store = new SessionTabStore(area, async () => versionKeyForTab(1), 3);
    for (let i = 1; i <= 5; i++) {
      await store.putVersion(version(`v${i}`, i));
      // createdAt = i so v1 is oldest, v5 newest.
      await store.putRun({ ...run(`v${i}`, i), createdAt: i });
    }
    // All 5 versions retained (metadata is cheap)...
    expect((await store.getVersions()).map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    // ...but only the 3 most-recent run blobs.
    expect(await store.getRun('v1')).toBeNull();
    expect(await store.getRun('v2')).toBeNull();
    expect((await store.getRun('v3'))?.summary.overall).toBe(3);
    expect((await store.getRun('v5'))?.summary.overall).toBe(5);
  });

  it('should surface a typed QuotaExceededError when set throws (quota)', async () => {
    class QuotaArea implements StorageArea {
      async get(): Promise<Record<string, unknown>> {
        return {};
      }
      async set(): Promise<void> {
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      async remove(): Promise<void> {}
    }
    const store = new SessionTabStore(new QuotaArea(), async () => versionKeyForTab(1));
    await expect(store.putRun(run('v1', 8))).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('clearHistory should drop all versions and runs', async () => {
    const store = storeFor(new InMemoryStorageArea(), 1);
    await store.putVersion(version('v1', 1));
    await store.putRun(run('v1', 8));
    expect(await store.getVersions()).toHaveLength(1);

    await store.clearHistory();
    expect(await store.getVersions()).toEqual([]);
    expect(await store.getRun('v1')).toBeNull();
  });
});
