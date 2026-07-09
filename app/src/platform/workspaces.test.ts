import { describe, it, expect } from 'vitest';
import type { StorageArea } from './storage';
import type { PromptVersion } from '../shared/types';
import { SessionTabStore, DURABLE_VERSION_KEY, VERSION_KEY_PREFIX } from './sessionTabStore';
import {
  WORKSPACE_INDEX_KEY,
  WORKSPACE_SCHEMA_VERSION,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  asIndex,
  workspaceKey,
  readIndex,
  activeWorkspaceId,
  activeWorkspaceKey,
  createWorkspace,
  renameWorkspace,
  setActive,
  deleteWorkspace,
  type WorkspaceDeps,
} from './workspaces';

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

/** Deterministic id/clock (ADR 0008: side effects injected). */
function deps(): WorkspaceDeps {
  let n = 0;
  let t = 1000;
  return { genId: () => `ws-${++n}`, now: () => (t += 1) };
}

const version = (id: string, index: number): PromptVersion => ({
  id,
  index,
  text: `prompt ${index}`,
  createdAt: index,
  parentId: null,
  note: 'baseline',
});

describe('workspaceKey', () => {
  it('should resolve the default workspace to the ADR-0004 durable key (adoption, no data move)', () => {
    expect(workspaceKey(DEFAULT_WORKSPACE_ID)).toBe(DURABLE_VERSION_KEY);
    expect(workspaceKey('ws-1')).toBe(`${VERSION_KEY_PREFIX}ws-1`);
  });
});

describe('asIndex (tolerant read + adoption)', () => {
  it('should adopt a single Default workspace when nothing is stored', () => {
    const index = asIndex(undefined);
    expect(index.activeId).toBe(DEFAULT_WORKSPACE_ID);
    expect(index.workspaces).toEqual([{ id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, createdAt: 0 }]);
  });

  it('should degrade a drifted / non-object index to the adopted Default (no throw)', () => {
    expect(asIndex('garbage').activeId).toBe(DEFAULT_WORKSPACE_ID);
    expect(asIndex({ workspaces: 'nope' }).workspaces).toHaveLength(1);
    expect(asIndex({ workspaces: [] }).workspaces[0]?.id).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('should drop invalid workspace entries but keep valid ones', () => {
    const index = asIndex({
      activeId: 'a',
      workspaces: [{ id: 'a', name: 'A', createdAt: 5 }, { id: '', name: 'bad' }, { name: 'no-id' }, null],
    });
    expect(index.workspaces).toEqual([{ id: 'a', name: 'A', createdAt: 5 }]);
  });

  it('should fall back activeId to the first workspace when it dangles', () => {
    const index = asIndex({ activeId: 'gone', workspaces: [{ id: 'a', name: 'A', createdAt: 1 }] });
    expect(index.activeId).toBe('a');
  });
});

describe('adoption (ADR 0008: zero data loss)', () => {
  it('active key of an unconfigured store equals the pre-0008 durable key', async () => {
    const area = new InMemoryStorageArea();
    expect(await activeWorkspaceKey(area)).toBe(DURABLE_VERSION_KEY);
    expect(await activeWorkspaceId(area)).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('legacy history read through the workspace resolver equals the legacy blob', async () => {
    const area = new InMemoryStorageArea();
    // Pre-0008 durable history under the fixed key, no workspace index yet.
    await area.set({ [DURABLE_VERSION_KEY]: { schemaVersion: 1, versions: [version('v1', 1)], runs: {} } });
    const store = new SessionTabStore(area, () => activeWorkspaceKey(area));
    const got = await store.getVersions();
    expect(got.map((v) => v.id)).toEqual(['v1']);
  });
});

describe('createWorkspace', () => {
  it('should add a workspace with an opaque id and make it active', async () => {
    const area = new InMemoryStorageArea();
    const index = await createWorkspace(area, 'Summarizer', deps());
    expect(index.workspaces).toHaveLength(2); // adopted Default + new one
    const created = index.workspaces.find((w) => w.name === 'Summarizer');
    expect(created?.id).toBe('ws-1');
    expect(index.activeId).toBe('ws-1');
    // Persisted with the schema version stamped.
    const stored = area.store.get(WORKSPACE_INDEX_KEY) as { schemaVersion: number };
    expect(stored.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
  });

  it('should keep the untrusted name out of the key space (name never becomes a key)', async () => {
    const area = new InMemoryStorageArea();
    const index = await createWorkspace(area, '<img src=x onerror=alert(1)>', deps());
    const created = index.workspaces.find((w) => w.id === 'ws-1');
    expect(created?.name).toBe('<img src=x onerror=alert(1)>'); // stored verbatim; escaping is the view layer's job
    expect(workspaceKey(created!.id)).toBe(`${VERSION_KEY_PREFIX}ws-1`); // key derived from id only
  });

  it('should fall back a blank name to Untitled and clamp length', async () => {
    const area = new InMemoryStorageArea();
    const d = deps();
    expect((await createWorkspace(area, '   ', d)).workspaces.at(-1)?.name).toBe('Untitled');
    const long = 'x'.repeat(200);
    expect((await createWorkspace(area, long, d)).workspaces.at(-1)?.name).toHaveLength(80);
  });
});

describe('isolation (ADR 0008)', () => {
  it('versions written under workspace A are absent from workspace B', async () => {
    const area = new InMemoryStorageArea();
    const d = deps();
    await createWorkspace(area, 'A', d); // active = ws-1
    const storeA = new SessionTabStore(area, () => activeWorkspaceKey(area));
    await storeA.putVersion(version('a1', 1));

    await createWorkspace(area, 'B', d); // active = ws-2
    const storeB = new SessionTabStore(area, () => activeWorkspaceKey(area));
    expect(await storeB.getVersions()).toEqual([]);
    await storeB.putVersion(version('b1', 1));

    // Switch back to A: its history is intact and B's is not visible.
    await setActive(area, 'ws-1');
    const storeA2 = new SessionTabStore(area, () => activeWorkspaceKey(area));
    expect((await storeA2.getVersions()).map((v) => v.id)).toEqual(['a1']);
  });
});

describe('setActive', () => {
  it('should switch the active workspace and persist it', async () => {
    const area = new InMemoryStorageArea();
    const d = deps();
    await createWorkspace(area, 'A', d);
    await createWorkspace(area, 'B', d);
    await setActive(area, 'ws-1');
    expect(await activeWorkspaceId(area)).toBe('ws-1');
  });

  it('should ignore an unknown id so activeId never dangles', async () => {
    const area = new InMemoryStorageArea();
    await createWorkspace(area, 'A', deps());
    await setActive(area, 'does-not-exist');
    expect(await activeWorkspaceId(area)).toBe('ws-1');
  });
});

describe('renameWorkspace', () => {
  it('should rename by id and no-op on an unknown id', async () => {
    const area = new InMemoryStorageArea();
    await createWorkspace(area, 'Old', deps());
    const renamed = await renameWorkspace(area, 'ws-1', 'New');
    expect(renamed.workspaces.find((w) => w.id === 'ws-1')?.name).toBe('New');
    const unchanged = await renameWorkspace(area, 'nope', 'X');
    expect(unchanged.workspaces.find((w) => w.id === 'ws-1')?.name).toBe('New');
  });
});

describe('deleteWorkspace', () => {
  it('should remove the entry AND its history blob, leaving others intact', async () => {
    const area = new InMemoryStorageArea();
    const d = deps();
    await createWorkspace(area, 'A', d); // ws-1
    const storeA = new SessionTabStore(area, () => activeWorkspaceKey(area));
    await storeA.putVersion(version('a1', 1));
    await createWorkspace(area, 'B', d); // ws-2

    const index = await deleteWorkspace(area, 'ws-1');
    expect(index.workspaces.some((w) => w.id === 'ws-1')).toBe(false);
    expect(area.store.has(workspaceKey('ws-1'))).toBe(false); // history namespace gone
    expect(index.workspaces.some((w) => w.id === DEFAULT_WORKSPACE_ID)).toBe(true);
  });

  it('should fall back activeId when the active workspace is deleted', async () => {
    const area = new InMemoryStorageArea();
    const d = deps();
    await createWorkspace(area, 'A', d); // ws-1, active
    await createWorkspace(area, 'B', d); // ws-2, active
    const index = await deleteWorkspace(area, 'ws-2'); // delete the active one
    expect(index.activeId).not.toBe('ws-2');
    expect(index.workspaces.some((w) => w.id === index.activeId)).toBe(true);
  });

  it('should reset to a single adopted Default when the last workspace is deleted', async () => {
    const area = new InMemoryStorageArea();
    // Start from just the adopted Default, then delete it.
    const index = await deleteWorkspace(area, DEFAULT_WORKSPACE_ID);
    expect(index.workspaces).toHaveLength(1);
    expect(index.workspaces[0]?.id).toBe(DEFAULT_WORKSPACE_ID);
    expect(index.activeId).toBe(DEFAULT_WORKSPACE_ID);
  });
});

describe('readIndex resilience', () => {
  it('should degrade to the adopted Default when the area read throws', async () => {
    const throwing: StorageArea = {
      get: () => Promise.reject(new Error('boom')),
      set: async () => {},
      remove: async () => {},
    };
    const index = await readIndex(throwing);
    expect(index.activeId).toBe(DEFAULT_WORKSPACE_ID);
  });
});
