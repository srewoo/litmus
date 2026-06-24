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

  it('should return a copy of versions, not the internal array', async () => {
    const store = new InMemoryStore();
    await store.putVersion(version('v1', 1));
    const a = await store.getVersions();
    a.push(version('hacked', 99));
    expect((await store.getVersions()).map((v) => v.id)).toEqual(['v1']);
  });
});
