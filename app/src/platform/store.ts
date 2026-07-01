/**
 * Async persistence contract for prompt versions and their runs (PRD F8/F11).
 * The loop and UI depend only on PersistentStore. InMemoryStore is the testable
 * default; the browser-backed IndexedDbStore lives in ./indexedDbStore.
 */
import type { CaseResult, DimensionScore, PromptVersion, RunSummary } from '../shared/types';
import type { RubricHealth } from '../core/rubric';

export interface RunRecord {
  readonly versionId: string;
  readonly summary: RunSummary;
  readonly results: readonly CaseResult[];
  /** Aggregated per-dimension scores for the version litmus axis. */
  readonly dimensions?: readonly DimensionScore[];
  /** Discrimination + consistency of the rubric on this run. */
  readonly rubricHealth?: RubricHealth;
  readonly createdAt: number;
}

export interface PersistentStore {
  getVersions(): Promise<PromptVersion[]>;
  putVersion(version: PromptVersion): Promise<void>;
  getRun(versionId: string): Promise<RunRecord | null>;
  putRun(record: RunRecord): Promise<void>;
  /**
   * Atomically allocate the next 1-based index and persist the version built
   * from it, in a single critical section. Prevents the read-then-write race
   * where two concurrent passes both read N versions and both write index N+1
   * (colliding ids and corrupting timeline order). `build` receives the
   * allocated index and the current latest version (for note/parent logic).
   */
  appendVersion(build: (index: number, prev: PromptVersion | undefined) => PromptVersion): Promise<PromptVersion>;
}

export class InMemoryStore implements PersistentStore {
  private readonly versions: PromptVersion[] = [];
  private readonly runs = new Map<string, RunRecord>();

  async getVersions(): Promise<PromptVersion[]> {
    return [...this.versions];
  }
  async putVersion(version: PromptVersion): Promise<void> {
    this.versions.push(version);
  }
  async appendVersion(build: (index: number, prev: PromptVersion | undefined) => PromptVersion): Promise<PromptVersion> {
    // Atomic: no `await` between the read and the push, so a concurrent
    // appendVersion runs as a separate microtask fully after this one.
    const index = this.versions.length + 1;
    const prev = this.versions[this.versions.length - 1];
    const version = build(index, prev);
    this.versions.push(version);
    return version;
  }
  async getRun(versionId: string): Promise<RunRecord | null> {
    return this.runs.get(versionId) ?? null;
  }
  async putRun(record: RunRecord): Promise<void> {
    this.runs.set(record.versionId, record);
  }
}
