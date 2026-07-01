import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './store';
import type { PromptVersion, RunSummary } from '../shared/types';

const version = (id: string, index: number): PromptVersion => ({
  id,
  index,
  text: 'p',
  note: '',
  parentId: null,
  createdAt: index,
});

const summary: RunSummary = {
  overall: 8,
  passCount: 10,
  failCount: 2,
  total: 12,
  speed: { ttfbMs: 600, avgResponseMs: 1600, tokensPerSec: 94 },
};

describe('InMemoryStore', () => {
  it('should persist and return versions', async () => {
    const store = new InMemoryStore();
    await store.putVersion(version('v1', 1));
    await store.putVersion(version('v2', 2));
    const versions = await store.getVersions();
    expect(versions.map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  it('should store and fetch a run by version id, null when missing', async () => {
    const store = new InMemoryStore();
    expect(await store.getRun('v1')).toBeNull();
    await store.putRun({ versionId: 'v1', summary, results: [], createdAt: 1 });
    expect((await store.getRun('v1'))?.summary.overall).toBe(8);
  });

  it('appendVersion should allocate sequential 1-based indexes and pass the previous version', async () => {
    const store = new InMemoryStore();
    const seenPrev: (string | undefined)[] = [];
    const v1 = await store.appendVersion((index, prev) => {
      seenPrev.push(prev?.id);
      return version(`v${index}`, index);
    });
    const v2 = await store.appendVersion((index, prev) => {
      seenPrev.push(prev?.id);
      return version(`v${index}`, index);
    });
    expect([v1.index, v2.index]).toEqual([1, 2]);
    expect(seenPrev).toEqual([undefined, 'v1']); // v2's build saw v1 as prev
    expect((await store.getVersions()).map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  it('appendVersion should not collide indexes under concurrent calls', async () => {
    const store = new InMemoryStore();
    const built = await Promise.all(
      Array.from({ length: 5 }, () => store.appendVersion((index) => version(`v${index}`, index))),
    );
    const indexes = built.map((v) => v.index).sort((a, b) => a - b);
    expect(indexes).toEqual([1, 2, 3, 4, 5]); // all distinct, no duplicate N+1
    expect((await store.getVersions())).toHaveLength(5);
  });

  it('should return a copy of versions, not the internal array', async () => {
    const store = new InMemoryStore();
    await store.putVersion(version('v1', 1));
    const a = await store.getVersions();
    a.push(version('hacked', 99));
    expect((await store.getVersions()).map((v) => v.id)).toEqual(['v1']);
  });
});
