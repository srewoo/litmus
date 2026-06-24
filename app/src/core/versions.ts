/**
 * Prompt version model — the product's spine. Every loop pass saves a version.
 * Storage is abstracted behind VersionStore; id and clock are injected so the
 * creation logic stays pure and deterministically testable.
 */
import type { PromptVersion } from '../shared/types';

export interface VersionStore {
  list(): readonly PromptVersion[];
  add(version: PromptVersion): void;
}

export interface VersionInput {
  readonly text: string;
  readonly note: string;
  readonly parentId: string | null;
}

export interface VersionDeps {
  readonly id: string;
  readonly now: number;
}

/** Append a new version; its index is 1-based and monotonic with store size. */
export function createVersion(
  store: VersionStore,
  input: VersionInput,
  deps: VersionDeps,
): PromptVersion {
  const version: PromptVersion = {
    id: deps.id,
    index: store.list().length + 1,
    text: input.text,
    note: input.note,
    parentId: input.parentId,
    createdAt: deps.now,
  };
  store.add(version);
  return version;
}

export function latestVersion(store: VersionStore): PromptVersion | null {
  const all = store.list();
  return all.length === 0 ? null : (all[all.length - 1] ?? null);
}

/** Simple in-memory store. The extension will swap in an IndexedDB-backed store. */
export class InMemoryVersionStore implements VersionStore {
  private readonly versions: PromptVersion[] = [];

  list(): readonly PromptVersion[] {
    return this.versions;
  }

  add(version: PromptVersion): void {
    this.versions.push(version);
  }
}
