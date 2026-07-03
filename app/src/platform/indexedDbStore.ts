/** Browser-backed PersistentStore (IndexedDB). Exercised in-extension, not in unit tests. */
import type { PromptVersion } from '../shared/types';
import type { PersistentStore, RunRecord } from './store';

const DB_NAME = 'litmus';
const DB_VERSION = 1;
const VERSIONS_STORE = 'versions';
const RUNS_STORE = 'runs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VERSIONS_STORE)) db.createObjectStore(VERSIONS_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(RUNS_STORE)) db.createObjectStore(RUNS_STORE, { keyPath: 'versionId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

export class IndexedDbStore implements PersistentStore {
  async getVersions(): Promise<PromptVersion[]> {
    const db = await openDb();
    const all = await promisifyRequest(db.transaction(VERSIONS_STORE, 'readonly').objectStore(VERSIONS_STORE).getAll());
    db.close();
    return (all as PromptVersion[]).sort((a, b) => a.index - b.index);
  }
  async putVersion(version: PromptVersion): Promise<void> {
    const db = await openDb();
    await promisifyRequest(db.transaction(VERSIONS_STORE, 'readwrite').objectStore(VERSIONS_STORE).put(version));
    db.close();
  }
  async appendVersion(build: (index: number, prev: PromptVersion | undefined) => PromptVersion): Promise<PromptVersion> {
    const db = await openDb();
    try {
      // Read the current versions and put the new one within ONE readwrite
      // transaction so index allocation is atomic (IndexedDB serializes
      // overlapping readwrite transactions on the same store).
      const store = db.transaction(VERSIONS_STORE, 'readwrite').objectStore(VERSIONS_STORE);
      const all = ((await promisifyRequest(store.getAll())) as PromptVersion[]).sort((a, b) => a.index - b.index);
      const index = all.length + 1;
      const prev = all[all.length - 1];
      const version = build(index, prev);
      await promisifyRequest(store.put(version));
      return version;
    } finally {
      db.close();
    }
  }
  async getRun(versionId: string): Promise<RunRecord | null> {
    const db = await openDb();
    const rec = await promisifyRequest(db.transaction(RUNS_STORE, 'readonly').objectStore(RUNS_STORE).get(versionId));
    db.close();
    return (rec as RunRecord | undefined) ?? null;
  }
  async putRun(record: RunRecord): Promise<void> {
    const db = await openDb();
    await promisifyRequest(db.transaction(RUNS_STORE, 'readwrite').objectStore(RUNS_STORE).put(record));
    db.close();
  }
  async clearHistory(): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction([VERSIONS_STORE, RUNS_STORE], 'readwrite');
      await Promise.all([
        promisifyRequest(tx.objectStore(VERSIONS_STORE).clear()),
        promisifyRequest(tx.objectStore(RUNS_STORE).clear()),
      ]);
    } finally {
      db.close();
    }
  }
}
