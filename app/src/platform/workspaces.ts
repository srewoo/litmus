/**
 * Named workspaces (ADR 0008): multiple independent prompt histories.
 *
 * ADR 0004 made version/run history durable under ONE fixed key. A user who
 * iterates on two different prompts got both interleaved into a single history,
 * so the litmus axis charted v-vs-v across unrelated prompts. This module turns
 * the fixed key into a per-workspace one: an index (`litmus:workspaces`) names
 * the workspaces and remembers the active one, and each workspace owns its own
 * `litmus:versions:<id>` namespace — reusing the SessionTabStore/serialization/
 * schema machinery from ADR 0004 unchanged (the key resolver is the only swap).
 *
 * Pure + injected StorageArea, so it's unit-testable without chrome.* . Ids and
 * the clock are injected (same DI pattern as the rest of litmus) so tests are
 * deterministic. Reads are tolerant (a missing/drifted index degrades to a single
 * adopted "Default" workspace) and never write — the legacy blob is adopted, never
 * stranded (ADR 0008: zero data loss).
 */
import type { StorageArea } from './storage';
import { VERSION_KEY_PREFIX } from './sessionTabStore';

/** chrome.storage key for the workspace index. */
export const WORKSPACE_INDEX_KEY = 'litmus:workspaces';

/**
 * Index schema version. Bump + branch in `asIndex()` when the shape changes, so
 * an older index is upgraded in place rather than discarded (mirrors ADR 0004).
 */
export const WORKSPACE_SCHEMA_VERSION = 1;

/**
 * Id of the adopted legacy workspace. Its version key resolves to
 * `litmus:versions:default` — the exact pre-0008 DURABLE_VERSION_KEY — so an
 * existing user's whole history becomes the "Default" workspace with no copy or
 * migration of the blob itself.
 */
export const DEFAULT_WORKSPACE_ID = 'default';
export const DEFAULT_WORKSPACE_NAME = 'Default';

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface WorkspaceIndex {
  readonly schemaVersion: number;
  readonly activeId: string;
  readonly workspaces: readonly Workspace[];
}

/** Side effects injected for determinism under test. */
export interface WorkspaceDeps {
  /** Opaque, stable id generator (e.g. crypto.randomUUID). */
  readonly genId: () => string;
  /** Wall clock for createdAt. */
  readonly now: () => number;
}

/**
 * The synthesized index when none is stored: one "Default" workspace keyed on the
 * legacy durable namespace, active. createdAt is 0 (epoch) because a READ must not
 * invent a timestamp or write — the real timestamp only matters for user-created
 * workspaces. This is the adoption path (ADR 0008).
 */
function defaultIndex(): WorkspaceIndex {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeId: DEFAULT_WORKSPACE_ID,
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, createdAt: 0 }],
  };
}

/** A stored workspace entry is valid only with a non-empty string id + name. */
function asWorkspace(value: unknown): Workspace | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const id = v['id'];
  const name = v['name'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  const createdAt = typeof v['createdAt'] === 'number' ? v['createdAt'] : 0;
  return { id, name, createdAt };
}

/**
 * Tolerant shape guard + forward-migration for the index. A missing, non-object,
 * or empty/invalid index degrades to the adopted Default (never throws, never
 * strands the legacy blob). An `activeId` that doesn't match any workspace falls
 * back to the first workspace so the resolver can never return a dangling key.
 */
export function asIndex(value: unknown): WorkspaceIndex {
  if (typeof value !== 'object' || value === null) return defaultIndex();
  const v = value as Record<string, unknown>;
  const raw = Array.isArray(v['workspaces']) ? (v['workspaces'] as unknown[]) : [];
  const workspaces = raw.map(asWorkspace).filter((w): w is Workspace => w !== null);
  if (workspaces.length === 0) return defaultIndex();
  const activeRaw = v['activeId'];
  const activeId =
    typeof activeRaw === 'string' && workspaces.some((w) => w.id === activeRaw)
      ? activeRaw
      : (workspaces[0] as Workspace).id;
  // (No migrations yet — schemaVersion 1 is the only shape. New shapes branch here.)
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, activeId, workspaces };
}

/** The version-history storage key for a workspace id. `default` → the ADR-0004 key. */
export function workspaceKey(id: string): string {
  return `${VERSION_KEY_PREFIX}${id}`;
}

/** Read the (tolerant, adoption-aware) index. Side-effect-free. */
export async function readIndex(area: StorageArea): Promise<WorkspaceIndex> {
  try {
    const got = await area.get(WORKSPACE_INDEX_KEY);
    return asIndex(got[WORKSPACE_INDEX_KEY]);
  } catch {
    // A transient read failure must not brick the panel or fork history — degrade
    // to the adopted Default, same posture as SessionTabStore.readSafe (ADR 0004).
    return defaultIndex();
  }
}

async function writeIndex(area: StorageArea, index: WorkspaceIndex): Promise<void> {
  await area.set({
    [WORKSPACE_INDEX_KEY]: {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      activeId: index.activeId,
      workspaces: index.workspaces,
    },
  });
}

/** The active workspace's id (adopted 'default' when no index is stored). */
export async function activeWorkspaceId(area: StorageArea): Promise<string> {
  return (await readIndex(area)).activeId;
}

/** The active workspace's version-history key — this is the SessionTabStore resolver. */
export async function activeWorkspaceKey(area: StorageArea): Promise<string> {
  return workspaceKey(await activeWorkspaceId(area));
}

/** Trim a user-supplied name; fall back so a blank name never yields an unnamed entry. */
function cleanName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 80) : 'Untitled';
}

/**
 * Create a new workspace and make it active. The new id is opaque (injected
 * generator), so the untrusted display name never enters the key space. Persists
 * the index (creating it from the adopted Default if it didn't exist yet).
 */
export async function createWorkspace(area: StorageArea, name: string, deps: WorkspaceDeps): Promise<WorkspaceIndex> {
  const index = await readIndex(area);
  const id = deps.genId();
  const workspace: Workspace = { id, name: cleanName(name), createdAt: deps.now() };
  const next: WorkspaceIndex = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeId: id,
    workspaces: [...index.workspaces, workspace],
  };
  await writeIndex(area, next);
  return next;
}

/** Rename a workspace. Unknown id is a no-op (returns the index unchanged). */
export async function renameWorkspace(area: StorageArea, id: string, name: string): Promise<WorkspaceIndex> {
  const index = await readIndex(area);
  const next: WorkspaceIndex = {
    ...index,
    workspaces: index.workspaces.map((w) => (w.id === id ? { ...w, name: cleanName(name) } : w)),
  };
  await writeIndex(area, next);
  return next;
}

/** Switch the active workspace. Unknown id is ignored so activeId can't dangle. */
export async function setActive(area: StorageArea, id: string): Promise<WorkspaceIndex> {
  const index = await readIndex(area);
  if (!index.workspaces.some((w) => w.id === id)) return index;
  const next: WorkspaceIndex = { ...index, activeId: id };
  await writeIndex(area, next);
  return next;
}

/**
 * Delete a workspace: drop its index entry AND remove its version-history blob
 * (a whole-key remove is atomic at the area level, so it needs no read-modify-
 * write serialization). If the deleted workspace was active, fall back to the
 * first remaining one; if it was the last workspace, reset to the adopted Default
 * so the panel always has exactly one live workspace and activeId never dangles.
 */
export async function deleteWorkspace(area: StorageArea, id: string): Promise<WorkspaceIndex> {
  const index = await readIndex(area);
  const remaining = index.workspaces.filter((w) => w.id !== id);
  // Remove the deleted workspace's history namespace (no-op if it never wrote).
  await area.remove(workspaceKey(id));
  if (remaining.length === 0) {
    const fresh = defaultIndex();
    await writeIndex(area, fresh);
    return fresh;
  }
  const activeId = index.activeId === id ? (remaining[0] as Workspace).id : index.activeId;
  const next: WorkspaceIndex = { schemaVersion: WORKSPACE_SCHEMA_VERSION, activeId, workspaces: remaining };
  await writeIndex(area, next);
  return next;
}
