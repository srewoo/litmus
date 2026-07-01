/**
 * Per-tab, session-scoped PersistentStore for prompt versions and their runs.
 *
 * Version history is meant to belong to the tab you're working in: a tab that
 * hasn't run anything shows no versions, and when the tab closes its history is
 * gone. We get both by keying the whole blob on the panel's tab id in
 * chrome.storage.session — a new tab gets a fresh (empty) namespace, and the
 * background worker deletes the namespace on chrome.tabs.onRemoved. Session
 * storage also clears on browser shutdown, which matches "this session".
 *
 * Implements the same PersistentStore contract as IndexedDbStore, so it drops in
 * at the single construction site with no consumer changes. The tab-key resolver
 * is injected, so this is unit-testable without chrome.* .
 */
import type { PromptVersion } from '../shared/types';
import type { PersistentStore, RunRecord } from './store';
import type { StorageArea } from './storage';

/** chrome.storage key prefix for version history. Kept in sync with background.js. */
export const VERSION_KEY_PREFIX = 'litmus:versions:';

/**
 * Durable single-namespace key (ADR 0004). Version history now lives in
 * chrome.storage.local under this fixed key so it survives tab close + browser
 * restart. A future multi-prompt/workspace layer swaps this for a per-workspace
 * key; the store itself is namespace-agnostic.
 */
export const DURABLE_VERSION_KEY = `${VERSION_KEY_PREFIX}default`;

/** Build the storage key for a given tab id (or a stable fallback when unknown). */
export function versionKeyForTab(tabId: number | undefined): string {
  return `${VERSION_KEY_PREFIX}${tabId ?? 'panel'}`;
}

/**
 * Stored-blob schema version. Bump when the persisted shape changes and add a
 * branch in `migrate()` so old durable data is upgraded in place rather than
 * silently discarded (ADR 0004). Reads tolerate a missing version (legacy v1).
 */
export const SCHEMA_VERSION = 1;

interface VersionBlob {
  schemaVersion: number;
  versions: PromptVersion[];
  runs: Record<string, RunRecord>;
}

const EMPTY: VersionBlob = { schemaVersion: SCHEMA_VERSION, versions: [], runs: {} };

/**
 * Tolerant shape guard + forward-migration. Extracts versions/runs regardless of
 * extra fields, and stamps the current schema version. A future shape change
 * adds a `if (stored < N)` migration here instead of resetting to empty — so an
 * upgrade never throws away a user's durable history.
 */
function asBlob(value: unknown): VersionBlob {
  if (typeof value !== 'object' || value === null) return { ...EMPTY };
  const v = value as Record<string, unknown>;
  const versions = Array.isArray(v['versions']) ? (v['versions'] as PromptVersion[]) : [];
  const runs = typeof v['runs'] === 'object' && v['runs'] !== null ? (v['runs'] as Record<string, RunRecord>) : {};
  // (No migrations yet — schemaVersion 1 is the only shape. New shapes branch here.)
  return { schemaVersion: SCHEMA_VERSION, versions, runs };
}

export class SessionTabStore implements PersistentStore {
  /** Memoized key so every op in a panel session targets the same tab namespace. */
  private keyPromise: Promise<string> | null = null;

  /**
   * Tail of the mutation queue. Every read-modify-write op chains onto this so
   * its read sees the prior write's result — without serialization, concurrent
   * putVersion/putRun (the run loop drives up to 8 in flight) read the same blob
   * and the last write clobbers the others, losing saved runs/versions (P0).
   */
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly area: StorageArea,
    private readonly resolveKey: () => Promise<string>,
  ) {}

  private key(): Promise<string> {
    return (this.keyPromise ??= this.resolveKey());
  }

  /**
   * Run `op` after all previously-queued mutations complete. The tail is
   * advanced to a promise that resolves regardless of `op`'s outcome, so one
   * failing op never permanently breaks the chain for subsequent callers.
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(op, op);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async read(): Promise<VersionBlob> {
    try {
      const k = await this.key();
      const got = await this.area.get(k);
      return asBlob(got[k]);
    } catch {
      return { ...EMPTY, versions: [], runs: {} };
    }
  }

  private async write(blob: { versions: PromptVersion[]; runs: Record<string, RunRecord> }): Promise<void> {
    const k = await this.key();
    await this.area.set({ [k]: { schemaVersion: SCHEMA_VERSION, ...blob } });
  }

  async getVersions(): Promise<PromptVersion[]> {
    const { versions } = await this.read();
    return [...versions].sort((a, b) => a.index - b.index);
  }

  async putVersion(version: PromptVersion): Promise<void> {
    await this.enqueue(async () => {
      const blob = await this.read();
      const versions = blob.versions.filter((v) => v.id !== version.id);
      versions.push(version);
      await this.write({ versions, runs: blob.runs });
    });
  }

  async appendVersion(build: (index: number, prev: PromptVersion | undefined) => PromptVersion): Promise<PromptVersion> {
    // Runs through the SAME mutation queue as putVersion/putRun, so the
    // read → allocate-index → write is atomic w.r.t. every other mutation: two
    // concurrent appends can't both read N and write index N+1.
    return this.enqueue(async () => {
      const blob = await this.read();
      const sorted = [...blob.versions].sort((a, b) => a.index - b.index);
      const index = sorted.length + 1;
      const prev = sorted[sorted.length - 1];
      const version = build(index, prev);
      const versions = blob.versions.filter((v) => v.id !== version.id);
      versions.push(version);
      await this.write({ versions, runs: blob.runs });
      return version;
    });
  }

  async getRun(versionId: string): Promise<RunRecord | null> {
    const { runs } = await this.read();
    return runs[versionId] ?? null;
  }

  async putRun(record: RunRecord): Promise<void> {
    await this.enqueue(async () => {
      const blob = await this.read();
      await this.write({ versions: blob.versions, runs: { ...blob.runs, [record.versionId]: record } });
    });
  }
}
