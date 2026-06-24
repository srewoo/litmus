/**
 * Run orchestrator (PRD §8.6). For each eval case: generate an output from the
 * target model (capturing timing), judge it, and assemble a CaseResult. One case
 * failing (network/parse) is recorded as a failed result, never aborting the run.
 */
import type { CaseResult, EvalCase, RunSummary, TargetModel, Timing } from '../shared/types';
import type { Provider } from '../providers/types';
import type { Clock } from '../core/stream';
import type { FetchLike } from '../providers/types';
import { judgeOutput } from './judge';
import { chatOptions } from './opts';
import { summarizeRun, scorePasses, DEFAULT_PASS_THRESHOLD } from '../core/results';

export interface RunDeps {
  readonly target: TargetModel;
  readonly targetProvider: Provider;
  readonly targetKey: string;
  readonly judgeProvider: Provider;
  readonly judgeKey: string;
  readonly judgeModel: string;
  /** Optional generated eval-prompt rubric the judge scores against. */
  readonly rubric?: string;
  readonly passThreshold?: number;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export interface RunOutcome {
  readonly results: CaseResult[];
  readonly summary: RunSummary;
}

const ZERO_TIMING: Timing = { ttfbMs: 0, totalMs: 0, tokens: 0, tokensPerSec: 0 };

async function runOneCase(systemPrompt: string, evalCase: EvalCase, deps: RunDeps): Promise<CaseResult> {
  const threshold = deps.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  try {
    const generated = await deps.targetProvider.chat(
      {
        model: deps.target.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: evalCase.input },
        ],
      },
      chatOptions({ apiKey: deps.targetKey, fetchImpl: deps.fetchImpl, clock: deps.clock, signal: deps.signal }),
    );

    const verdict = await judgeOutput(systemPrompt, evalCase.input, generated.text, {
      provider: deps.judgeProvider,
      apiKey: deps.judgeKey,
      model: deps.judgeModel,
      rubric: deps.rubric,
      fetchImpl: deps.fetchImpl,
      clock: deps.clock,
      signal: deps.signal,
    });

    return {
      caseId: evalCase.id,
      output: generated.text,
      score: verdict.score,
      passed: scorePasses(verdict.score, threshold),
      rationale: verdict.rationale,
      timing: generated.timing,
      ...(verdict.dimensions ? { dimensions: verdict.dimensions } : {}),
    };
  } catch (err) {
    return {
      caseId: evalCase.id,
      output: '',
      score: 0,
      passed: false,
      rationale: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
      timing: ZERO_TIMING,
    };
  }
}

/** Run all cases sequentially (provider-friendly), then summarize quality + speed. */
export async function runEval(
  systemPrompt: string,
  cases: readonly EvalCase[],
  deps: RunDeps,
): Promise<RunOutcome> {
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    results.push(await runOneCase(systemPrompt, evalCase, deps));
  }
  return { results, summary: summarizeRun(results, deps.passThreshold ?? DEFAULT_PASS_THRESHOLD) };
}
