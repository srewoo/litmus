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
  async getRun(versionId: string): Promise<RunRecord | null> {
    return this.runs.get(versionId) ?? null;
  }
  async putRun(record: RunRecord): Promise<void> {
    this.runs.set(record.versionId, record);
  }
}
