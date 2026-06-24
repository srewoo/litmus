/**
 * Run orchestrator (PRD §8.6). For each eval case: generate an output from the
 * target model (capturing timing), judge it, and assemble a CaseResult. One case
 * failing (network/parse) is recorded as a failed result, never aborting the run.
 */
import type { CaseResult, EvalCase, RunSummary, TargetModel, Timing, ToolDef } from '../shared/types';
import type { ChatResponse, Provider } from '../providers/types';
import type { Clock } from '../core/stream';
import type { FetchLike } from '../providers/types';
import { judgeOutput } from './judge';
import { assertToolCalls, describeToolAssert } from './toolAssert';
import { runAgent, scoreScenario } from './agentRun';
import { providerStep } from './agentStep';
import { chatOptions } from './opts';
import { summarizeRun, scorePasses, foldSamples, DEFAULT_PASS_THRESHOLD } from '../core/results';

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
  /** Run each case this many times to measure run-to-run variance (default 1). */
  readonly samples?: number;
  /** Tool catalog available to the target this run (ADR 0001). Sent for tool cases. */
  readonly tools?: readonly ToolDef[];
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export interface RunOutcome {
  readonly results: CaseResult[];
  readonly summary: RunSummary;
}

const ZERO_TIMING: Timing = { ttfbMs: 0, totalMs: 0, tokens: 0, tokensPerSec: 0 };

/** Score a tool-expectation case deterministically (ADR 0001) — no judge involved. */
function toolCaseResult(evalCase: EvalCase, generated: ChatResponse, deps: RunDeps): CaseResult {
  const assert = assertToolCalls(generated.toolCalls ?? [], evalCase.toolExpectations ?? {}, deps.tools ?? []);
  return {
    caseId: evalCase.id,
    output: JSON.stringify(generated.toolCalls ?? []),
    score: assert.score,
    passed: assert.passed,
    rationale: describeToolAssert(assert),
    timing: generated.timing,
  };
}

/** Run a multi-turn agent scenario (ADR 0002) against the target and score the trajectory. */
async function scenarioCaseResult(systemPrompt: string, evalCase: EvalCase, deps: RunDeps): Promise<CaseResult> {
  const scenario = evalCase.scenario!;
  const tools: ToolDef[] = scenario.tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters,
  }));
  const step = providerStep({
    provider: deps.targetProvider,
    apiKey: deps.targetKey,
    model: deps.target.model,
    tools,
    fetchImpl: deps.fetchImpl,
    clock: deps.clock,
    signal: deps.signal,
  });
  const trajectory = await runAgent(systemPrompt, scenario, step, deps.signal);
  const verdict = scoreScenario(trajectory, scenario);
  return {
    caseId: evalCase.id,
    output: JSON.stringify(trajectory),
    score: verdict.score,
    passed: verdict.passed,
    rationale: verdict.rationale,
    timing: ZERO_TIMING, // multi-turn timing isn't aggregated yet
    dimensions: verdict.dimensions,
  };
}

async function runOneCase(systemPrompt: string, evalCase: EvalCase, deps: RunDeps): Promise<CaseResult> {
  const threshold = deps.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const isToolCase = evalCase.toolExpectations !== undefined;
  try {
    // Multi-turn agent scenario: run the loop, score the trajectory (no single generation).
    if (evalCase.scenario) return await scenarioCaseResult(systemPrompt, evalCase, deps);

    const generated = await deps.targetProvider.chat(
      {
        model: deps.target.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: evalCase.input },
        ],
        ...(isToolCase && deps.tools ? { tools: deps.tools } : {}),
      },
      chatOptions({ apiKey: deps.targetKey, fetchImpl: deps.fetchImpl, clock: deps.clock, signal: deps.signal }),
    );

    // Tool cases are scored by the deterministic checker, not the LLM judge.
    if (isToolCase) return toolCaseResult(evalCase, generated, deps);

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

/**
 * Run all cases sequentially (provider-friendly), then summarize quality + speed.
 * When `samples > 1`, each case is run that many times and folded into one result
 * with its run-to-run spread — so a noisy score is visible, not hidden.
 */
export async function runEval(
  systemPrompt: string,
  cases: readonly EvalCase[],
  deps: RunDeps,
): Promise<RunOutcome> {
  const threshold = deps.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const samples = Math.max(1, Math.floor(deps.samples ?? 1));
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const runs: CaseResult[] = [];
    for (let s = 0; s < samples; s++) runs.push(await runOneCase(systemPrompt, evalCase, deps));
    results.push(foldSamples(runs, threshold));
  }
  return { results, summary: summarizeRun(results, threshold) };
}
