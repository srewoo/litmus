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
    fetchImpl: deps.fetchImpl,
    clock: deps.clock,
    signal: deps.signal,
  });

  const fixes = await suggestFixes(input.systemPrompt, cases, outcome.results, {
    provider: deps.judgeProvider,
    apiKey: deps.judgeKey,
    model: deps.auxModel,
    passThreshold: deps.passThreshold,
    fetchImpl: deps.fetchImpl,
    clock: deps.clock,
    signal: deps.signal,
  });

  const index = (await deps.store.getVersions()).length + 1;
  const version: PromptVersion = {
    id: deps.makeVersionId(index),
    index,
    text: input.systemPrompt,
    note: input.note,
    parentId: input.parentId ?? null,
    createdAt: deps.now,
  };
  await deps.store.putVersion(version);
  await deps.store.putRun({
    versionId: version.id,
    summary: outcome.summary,
    results: outcome.results,
    createdAt: deps.now,
  });

  return { version, cases, outcome, fixes };
}
