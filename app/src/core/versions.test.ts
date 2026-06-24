import { describe, it, expect } from 'vitest';
import { createVersion, latestVersion, InMemoryVersionStore } from './versions';

describe('createVersion', () => {
  it('should assign a 1-based index to the first version', () => {
    const store = new InMemoryVersionStore();
    const v = createVersion(store, { text: 'p', note: 'baseline', parentId: null }, { id: 'v1', now: 100 });
    expect(v).toMatchObject({ id: 'v1', index: 1, parentId: null, createdAt: 100 });
  });

  it('should increment the index and link the parent on subsequent versions', () => {
    const store = new InMemoryVersionStore();
    const v1 = createVersion(store, { text: 'a', note: '', parentId: null }, { id: 'v1', now: 1 });
    const v2 = createVersion(store, { text: 'b', note: 'fix', parentId: v1.id }, { id: 'v2', now: 2 });
    expect(v2.index).toBe(2);
    expect(v2.parentId).toBe('v1');
    expect(store.list()).toHaveLength(2);
  });
});

describe('latestVersion', () => {
  it('should return null for an empty store', () => {
    expect(latestVersion(new InMemoryVersionStore())).toBeNull();
  });
  it('should return the most recently added version', () => {
    const store = new InMemoryVersionStore();
    createVersion(store, { text: 'a', note: '', parentId: null }, { id: 'v1', now: 1 });
    const v2 = createVersion(store, { text: 'b', note: '', parentId: 'v1' }, { id: 'v2', now: 2 });
    expect(latestVersion(store)).toBe(v2);
  });
});
