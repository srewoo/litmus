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
import { QuotaExceededError } from './store';
import type { StorageArea } from './storage';

/** Default cap on retained RunRecord blobs (versions metadata is small; kept in full). */
export const DEFAULT_MAX_RUNS = 50;

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
    /** Retain at most this many RunRecord blobs; oldest are pruned before write. */
    private readonly maxRuns: number = DEFAULT_MAX_RUNS,
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

  /**
   * Read used INSIDE a write critical section. A missing key is a legitimately
   * fresh namespace and returns EMPTY, but a storage failure MUST propagate: if
   * we swallowed it and returned EMPTY here, the caller would write a blob
   * derived from empty and wipe all durable history (the P0 read-swallow bug).
   */
  private async read(): Promise<VersionBlob> {
    const k = await this.key();
    const got = await this.area.get(k);
    return asBlob(got[k]);
  }

  /**
   * Read used for DISPLAY (getVersions/getRun). Here degrading to empty on a
   * transient storage error is acceptable — it only affects what's shown, never
   * what's persisted — so the panel renders instead of throwing.
   */
  private async readSafe(): Promise<VersionBlob> {
    try {
      return await this.read();
    } catch {
      return { ...EMPTY, versions: [], runs: {} };
    }
  }

  /**
   * Keep at most `maxRuns` RunRecord blobs, dropping the oldest by createdAt.
   * Versions metadata is tiny so all versions are retained; a version whose run
   * was pruned still shows in the timeline, just without run detail. Runs at the
   * quota boundary tie-break stably (later object order wins). Called on the
   * write path BEFORE area.set so we never grow the item unboundedly.
   */
  private prune(runs: Record<string, RunRecord>): Record<string, RunRecord> {
    const entries = Object.entries(runs);
    if (entries.length <= this.maxRuns) return runs;
    const kept = entries.sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, this.maxRuns);
    return Object.fromEntries(kept);
  }

  /**
   * Persist a blob. If the backing store rejects `set` (chrome.storage.local
   * byte quota is the common cause, even with unlimitedStorage during upgrade
   * windows), surface a typed QuotaExceededError the UI can catch — rather than
   * a bare throw that wedges the panel and loses a completed paid run.
   */
  private async writeBlob(blob: { versions: PromptVersion[]; runs: Record<string, RunRecord> }): Promise<void> {
    const k = await this.key();
    try {
      await this.area.set({ [k]: { schemaVersion: SCHEMA_VERSION, ...blob } });
    } catch (cause) {
      throw new QuotaExceededError('litmus: could not persist version history (storage quota exceeded)', { cause });
    }
  }

  /**
   * Merge-on-write. Re-reads the CURRENT stored blob immediately before writing
   * and applies `merge` ADDITIVELY, so a concurrent write from another side
   * panel (side panels are per-window but share one durable key, and
   * chrome.storage offers no transaction/CAS) is not clobbered by our stale
   * start-of-op snapshot. HONEST CAVEAT: this is an additive merge, not a true
   * DB transaction — a genuinely simultaneous byte-level get→set overlap can
   * still race, but it no longer SILENTLY drops the other window's versions/runs.
   */
  private async mergeWrite(
    merge: (current: VersionBlob) => { versions: PromptVersion[]; runs: Record<string, RunRecord> },
  ): Promise<void> {
    const current = await this.read();
    const merged = merge(current);
    await this.writeBlob({ versions: merged.versions, runs: this.prune(merged.runs) });
  }

  async getVersions(): Promise<PromptVersion[]> {
    const { versions } = await this.readSafe();
    return [...versions].sort((a, b) => a.index - b.index);
  }

  async putVersion(version: PromptVersion): Promise<void> {
    await this.enqueue(() =>
      this.mergeWrite((current) => {
        // Union by id: replace our own version, preserve every other window's.
        const versions = current.versions.filter((v) => v.id !== version.id);
        versions.push(version);
        return { versions, runs: current.runs };
      }),
    );
  }

  async appendVersion(build: (index: number, prev: PromptVersion | undefined) => PromptVersion): Promise<PromptVersion> {
    // Runs through the SAME intra-panel mutation queue as putVersion/putRun so
    // two appends WITHIN this panel can't both read N and write index N+1. The
    // merge-on-write below additionally protects against a cross-window append.
    return this.enqueue(async () => {
      const snapshot = await this.read();
      const sorted = [...snapshot.versions].sort((a, b) => a.index - b.index);
      const prev = sorted[sorted.length - 1];
      let version = build(sorted.length + 1, prev);
      await this.mergeWrite((current) => {
        const others = current.versions.filter((v) => v.id !== version.id);
        // Collision: another window already stored a version at our computed
        // index. Bump ours to max(existing)+1 so BOTH survive with distinct
        // indices instead of overwriting the timeline.
        if (others.some((v) => v.index === version.index)) {
          const maxIndex = others.reduce((m, v) => Math.max(m, v.index), 0);
          version = { ...version, index: maxIndex + 1 };
        }
        return { versions: [...others, version], runs: current.runs };
      });
      return version;
    });
  }

  async getRun(versionId: string): Promise<RunRecord | null> {
    const { runs } = await this.readSafe();
    return runs[versionId] ?? null;
  }

  async putRun(record: RunRecord): Promise<void> {
    await this.enqueue(() =>
      this.mergeWrite((current) => ({
        versions: current.versions,
        // Additive merge of the runs map: keep every other window's runs.
        runs: { ...current.runs, [record.versionId]: record },
      })),
    );
  }

  async clearHistory(): Promise<void> {
    // Deliberate wipe — goes through the queue but does NOT merge (that would
    // resurrect what we're clearing). Writes EMPTY directly.
    await this.enqueue(() => this.writeBlob({ versions: [], runs: {} }));
  }
}
