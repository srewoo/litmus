/**
 * Loop manager (PRD §8.1) — the capstone. Runs one full pass over a target:
 * optionally generate eval cases, run them, suggest fixes, and SAVE A VERSION
 * with its run record. This is what makes each iteration a kept, comparable
 * version. Everything it calls is already unit-tested; this wires them together.
 */
import type { EvalCase, PromptVersion, TargetModel } from '../shared/types';
import type { Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import type { PersistentStore } from '../platform/store';
import { generateCases } from './evalgen';
import { runEval } from './run';
import { suggestFixes } from './fixes';
import type { Fix } from './fixes';
import type { RunOutcome } from './run';

export interface LoopDeps {
  readonly target: TargetModel;
  readonly targetProvider: Provider;
  readonly targetKey: string;
  /** Judge/analyzer/fixer model — should differ from the target. */
  readonly judgeProvider: Provider;
  readonly judgeKey: string;
  readonly auxModel: string;
  readonly store: PersistentStore;
  readonly makeVersionId: (index: number) => string;
  readonly now: number;
  readonly passThreshold?: number;
  readonly caseCount?: number;
  /** Judge each quality case this many times and fold to the median (cuts judge noise). */
  readonly judgeSamples?: number;
  /** How many cases to run at once (1 = sequential). */
  readonly concurrency?: number;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export interface PassInput {
  readonly systemPrompt: string;
  readonly note: string;
  /** Provide to reuse a fixed case set across versions; omit to generate fresh. */
  readonly cases?: readonly EvalCase[];
  readonly parentId?: string | null;
}

export interface PassResult {
  readonly version: PromptVersion;
  readonly cases: readonly EvalCase[];
  readonly outcome: RunOutcome;
  readonly fixes: Fix[];
}

/** Run a full loop pass and persist the resulting version + run record. */
export async function runLoopPass(input: PassInput, deps: LoopDeps): Promise<PassResult> {
  const cases =
    input.cases ??
    (await generateCases(input.systemPrompt, deps.target, deps.caseCount ?? 12, {
      provider: deps.judgeProvider,
      apiKey: deps.judgeKey,
      model: deps.auxModel,
      fetchImpl: deps.fetchImpl,
      clock: deps.clock,
      signal: deps.signal,
    }));

  const outcome = await runEval(input.systemPrompt, cases, {
    target: deps.target,
    targetProvider: deps.targetProvider,
    targetKey: deps.targetKey,
    judgeProvider: deps.judgeProvider,
    judgeKey: deps.judgeKey,
    judgeModel: deps.auxModel,
    passThreshold: deps.passThreshold,
    judgeSamples: deps.judgeSamples,
    concurrency: deps.concurrency,
    fetchImpl: deps.fetchImpl,
    clock: deps.clock,
    signal: deps.signal,
  });

  // Persist the version + run BEFORE computing fixes: the eval is fully paid
  // for by this point, and suggestFixes is an LLM call that can throw. Losing a
  // completed run because the (advisory) fixer failed would be the costliest
  // possible failure, so persistence comes first and fixes degrade gracefully.
  //
  // Atomic index allocation + persist (see PersistentStore.appendVersion) so
  // concurrent passes can't collide on the same version index/id.
  const version = await deps.store.appendVersion((index) => ({
    id: deps.makeVersionId(index),
    index,
    text: input.systemPrompt,
    note: input.note,
    parentId: input.parentId ?? null,
    createdAt: deps.now,
  }));
  await deps.store.putRun({
    versionId: version.id,
    summary: outcome.summary,
    results: outcome.results,
    createdAt: deps.now,
  });

  // Fixes are advisory. A fixer failure must never discard the persisted run —
  // degrade to no suggestions instead.
  let fixes: Fix[] = [];
  try {
    fixes = await suggestFixes(input.systemPrompt, cases, outcome.results, {
      provider: deps.judgeProvider,
      apiKey: deps.judgeKey,
      model: deps.auxModel,
      passThreshold: deps.passThreshold,
      fetchImpl: deps.fetchImpl,
      clock: deps.clock,
      signal: deps.signal,
    });
  } catch {
    fixes = [];
  }

  return { version, cases, outcome, fixes };
}
