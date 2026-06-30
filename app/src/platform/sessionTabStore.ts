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

/** chrome.storage.session key prefix for a tab's version history. Kept in sync with background.js. */
export const VERSION_KEY_PREFIX = 'litmus:versions:';

/** Build the storage key for a given tab id (or a stable fallback when unknown). */
export function versionKeyForTab(tabId: number | undefined): string {
  return `${VERSION_KEY_PREFIX}${tabId ?? 'panel'}`;
}

interface VersionBlob {
  versions: PromptVersion[];
  runs: Record<string, RunRecord>;
}

const EMPTY: VersionBlob = { versions: [], runs: {} };

/** Tolerant shape guard — anything unexpected resets to an empty namespace. */
function asBlob(value: unknown): VersionBlob {
  if (typeof value !== 'object' || value === null) return { versions: [], runs: {} };
  const v = value as Record<string, unknown>;
  const versions = Array.isArray(v['versions']) ? (v['versions'] as PromptVersion[]) : [];
  const runs = typeof v['runs'] === 'object' && v['runs'] !== null ? (v['runs'] as Record<string, RunRecord>) : {};
  return { versions, runs };
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

  private async write(blob: VersionBlob): Promise<void> {
    const k = await this.key();
    await this.area.set({ [k]: blob });
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
