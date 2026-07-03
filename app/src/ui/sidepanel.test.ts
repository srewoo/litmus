/**
 * Unit tests for the DOM-free logic seams extracted from the sidepanel controller.
 *
 * sidepanel.ts is "DOM glue" (excluded from coverage) and its handlers touch the
 * live document, so the runtime env here is DOM-less node — importing the module
 * only exercises its exported pure helpers (init() is guarded on `document`).
 * Each test below pins one of the fixed UI-controller bugs to its extracted core.
 */
import { describe, it, expect } from 'vitest';
import {
  toolsForMode,
  estimateRunCost,
  buildVersionVMs,
  enqueueSettings,
  beginRun,
  abortActiveRun,
  isRestoring,
  runRestore,
  persistRunTo,
  QUOTA_STATUS,
} from './sidepanel';
import { InMemoryStore, QuotaExceededError } from '../platform/store';
import type { PersistentStore, RunRecord } from '../platform/store';
import type { PromptVersion, ToolDef } from '../shared/types';

const tool: ToolDef = { name: 'search', parameters: { type: 'object', properties: {} } };

function version(index: number, over: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: `v${index}`,
    index,
    text: `prompt ${index}`,
    note: 'baseline',
    parentId: null,
    createdAt: index,
    ...over,
  };
}

function runFor(versionId: string, overall: number): RunRecord {
  return {
    versionId,
    summary: {
      overall,
      passCount: 1,
      failCount: 0,
      total: 1,
      speed: { ttfbMs: 0, avgResponseMs: 1000, tokensPerSec: 0 },
    },
    results: [],
    createdAt: 0,
  };
}

// Bug 3 — stale tool catalog must not leak into quality-mode runs.
describe('toolsForMode', () => {
  it('should send the tool catalog in tool/agent mode', () => {
    expect(toolsForMode('tools', [tool])).toEqual([tool]);
  });

  it('should send NO tools in quality mode even when tools are defined', () => {
    expect(toolsForMode('quality', [tool])).toEqual([]);
  });
});

// Bug 6 — the spend cap must be re-checked at run time, not only on the Cases screen.
describe('estimateRunCost', () => {
  const base = {
    mode: 'quality' as const,
    cases: [
      { id: 'case-1', category: 'typical' as const, input: 'a', pinned: false },
      { id: 'case-2', category: 'typical' as const, input: 'b', pinned: false },
    ],
    judgeSamples: 1,
    targetModel: 'mystery',
    auxModel: 'mystery',
  };

  it('should stay under a generous cap at low sample counts', () => {
    const { over } = estimateRunCost({ ...base, samples: 1, spendCapUsd: 100 });
    expect(over).toBe(false);
  });

  it('should exceed the cap once samples are raised past it (the stale-Run bug)', () => {
    const low = estimateRunCost({ ...base, samples: 1, spendCapUsd: 0.5 });
    const high = estimateRunCost({ ...base, samples: 500, spendCapUsd: 0.5 });
    expect(low.over).toBe(false);
    expect(high.over).toBe(true);
    expect(high.est.estUsd).toBeGreaterThan(low.est.estUsd);
  });
});

// Bug 4 — no spurious delta against a version that has no run record.
describe('buildVersionVMs', () => {
  it('should not compute a delta against a run-less previous version', () => {
    const versions = [version(1), version(2)];
    // v1 has no run (overall implicitly 0); v2 scored 8.2. The delta for v2 must
    // be null ("no comparison"), not 8.2 measured against v1's phantom 0.
    const runs = new Map<string, RunRecord>([['v2', runFor('v2', 8.2)]]);
    const vms = buildVersionVMs(versions, (id) => runs.get(id) ?? null, 'v2');
    expect(vms[0]!.delta).toBeNull();
    expect(vms[1]!.delta).toBeNull();
  });

  it('should compute a real delta when both versions have runs', () => {
    const versions = [version(1), version(2)];
    const runs = new Map<string, RunRecord>([
      ['v1', runFor('v1', 6)],
      ['v2', runFor('v2', 8)],
    ]);
    const vms = buildVersionVMs(versions, (id) => runs.get(id) ?? null, 'v2');
    expect(vms[0]!.delta).toBeNull(); // first version has no predecessor
    expect(vms[1]!.delta).toBe(2);
    expect(vms[1]!.current).toBe(true);
  });

  it('should render an empty timeline after history is cleared', () => {
    expect(buildVersionVMs([], () => null, null)).toEqual([]);
  });
});

// Bug 5 — settings read-modify-writes must be serialized so none is lost.
describe('enqueueSettings', () => {
  it('should serialize interleaved read-modify-writes so no update is lost', async () => {
    const store = { a: 0, b: 0 };
    const slowRead = () => new Promise<typeof store>((r) => setTimeout(() => r({ ...store }), 5));
    // Two concurrent read-modify-writes on the same blob (e.g. setKey + onSaveSettings).
    const save = enqueueSettings(async () => {
      const s = await slowRead();
      store.a = s.a + 1;
      store.b = s.b;
    });
    const load = enqueueSettings(async () => {
      const s = await slowRead();
      store.b = s.b + 1;
      store.a = s.a;
    });
    await Promise.all([save, load]);
    // Serialized → both increments survive. (Unserialized, both read {0,0} and the
    // later write reverts the earlier increment — that is the lost-update bug.)
    expect(store).toEqual({ a: 1, b: 1 });
  });

  it('should keep the chain alive after a failing op', async () => {
    await expect(enqueueSettings(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(enqueueSettings(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

// Bug 1 — Cancel must abort the controller that the generation phase uses.
describe('run abort scope', () => {
  it('should abort the active controller even when opened before the eval run', () => {
    const ac = beginRun(); // opened at the START of the express generation phase
    expect(ac.signal.aborted).toBe(false);
    const wasActive = abortActiveRun(); // simulates onCancelRun during generation
    expect(wasActive).toBe(true);
    expect(ac.signal.aborted).toBe(true); // the SAME signal passed into generation is aborted
  });

  it('should report no active run once the scope is cleared', () => {
    beginRun();
    abortActiveRun();
    // A fresh scope replaces the aborted one.
    const ac2 = beginRun();
    expect(ac2.signal.aborted).toBe(false);
  });
});

// Bug 2 — a persist triggered mid-restore must not capture half-restored state.
describe('runRestore', () => {
  it('should suppress persistence during restore and fire once with restored keys', () => {
    const persisted: (string | null)[] = [];
    let suiteKey: string | null = null;
    // Models persistSession(): a no-op while restoring, otherwise it snapshots suiteKey.
    const persist = () => {
      if (isRestoring()) return;
      persisted.push(suiteKey);
    };
    runRestore(() => {
      persist(); // mid-restore trigger (like setMode → persistSession); suiteKey still null
      suiteKey = 'suite-1'; // keys restored AFTER the inner persist attempt
    }, persist);
    // Only the trailing persist ran, and it captured the restored key — not null.
    expect(persisted).toEqual(['suite-1']);
    expect(isRestoring()).toBe(false);
  });
});

// Bug 7a/7b — persistence degrades gracefully on a full store; clearHistory wipes.
describe('persistRunTo', () => {
  const build = (index: number): PromptVersion => version(index);
  const makeRun = (v: PromptVersion): RunRecord => runFor(v.id, 7);

  it('should persist a version + run against a healthy store', async () => {
    const store = new InMemoryStore();
    const { version: v, quota } = await persistRunTo(store, build, makeRun);
    expect(quota).toBe(false);
    expect(v?.index).toBe(1);
    expect(await store.getRun('v1')).not.toBeNull();
  });

  it('should flag quota (not throw) when the store is full, so results can still show', async () => {
    const full: PersistentStore = new InMemoryStore();
    full.putRun = async () => {
      throw new QuotaExceededError('full');
    };
    const { quota } = await persistRunTo(full, build, makeRun);
    expect(quota).toBe(true);
    expect(QUOTA_STATUS).toMatch(/clear history/i);
  });

  it('should propagate non-quota persistence errors', async () => {
    const broken: PersistentStore = new InMemoryStore();
    broken.appendVersion = async () => {
      throw new Error('disk on fire');
    };
    await expect(persistRunTo(broken, build, makeRun)).rejects.toThrow('disk on fire');
  });

  it('should clear all versions + runs via the store primitive (clear-history)', async () => {
    const store = new InMemoryStore();
    await persistRunTo(store, build, makeRun);
    await store.clearHistory();
    expect(await store.getVersions()).toEqual([]);
    expect(await store.getRun('v1')).toBeNull();
  });
});
