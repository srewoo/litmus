/**
 * Run orchestrator (PRD §8.6). For each eval case: generate an output from the
 * target model (capturing timing), judge it, and assemble a CaseResult. One case
 * failing (network/parse) is recorded as a failed result, never aborting the run.
 */
import type { CaseResult, EvalCase, RunSummary, TargetModel, Timing, ToolDef } from '../shared/types';
import type { ChatResponse, Provider } from '../providers/types';
import type { Clock } from '../core/stream';
import type { FetchLike } from '../providers/types';
import { judgeOutputEnsemble } from './judge';
import { assertToolCalls, describeToolAssert } from './toolAssert';
import { runAgent, scoreScenario } from './agentRun';
import { providerStep } from './agentStep';
import { mcpResolver } from './toolResolver';
import { connectMcp } from '../mcp/client';
import type { McpServerConfig } from '../mcp/types';
import { chatOptions } from './opts';
import { aggregateTrajectoryTiming } from '../core/timing';
import { mapWithConcurrency } from '../shared/concurrency';
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
  /**
   * Run the LLM judge this many times per quality case and fold to the median,
   * cutting single-call judge noise (default 1). Tool/agent cases are scored
   * deterministically and ignore this.
   */
  readonly judgeSamples?: number;
  /** Temperature for an ensemble judge; ignored when judgeSamples <= 1. */
  readonly judgeTemperature?: number;
  /**
   * How many cases to run at once (default 1 = sequential, provider-friendly).
   * Per-case failures are already captured, so a higher value never aborts the
   * run; result order is preserved regardless.
   */
  readonly concurrency?: number;
  /** Tool catalog available to the target this run (ADR 0001). Sent for tool cases. */
  readonly tools?: readonly ToolDef[];
  /** Configured MCP servers a scenario may target by id (ADR 0003). */
  readonly mcpServers?: readonly McpServerConfig[];
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

/** Run a multi-turn agent scenario against the target and score the trajectory. */
async function scenarioCaseResult(systemPrompt: string, evalCase: EvalCase, deps: RunDeps): Promise<CaseResult> {
  const scenario = evalCase.scenario!;
  // ADR 0003: an MCP-backed scenario discovers tools from a live server and
  // dispatches calls for real; otherwise the ADR 0002 mock path runs.
  const wired = scenario.mcpServerId
    ? await wireMcp(scenario.mcpServerId, deps)
    : { tools: mockToolDefs(scenario), resolver: undefined };

  const step = providerStep({
    provider: deps.targetProvider,
    apiKey: deps.targetKey,
    model: deps.target.model,
    tools: wired.tools,
    fetchImpl: deps.fetchImpl,
    clock: deps.clock,
    signal: deps.signal,
  });
  const trajectory = await runAgent(systemPrompt, scenario, step, deps.signal, wired.resolver);
  const verdict = scoreScenario(trajectory, scenario);
  const turnTimings = trajectory.steps.map((s) => s.timing).filter((t): t is Timing => t !== undefined);
  return {
    caseId: evalCase.id,
    output: JSON.stringify(trajectory),
    score: verdict.score,
    passed: verdict.passed,
    rationale: verdict.rationale,
    timing: aggregateTrajectoryTiming(turnTimings), // summed across turns (ADR 0002)
    dimensions: verdict.dimensions,
  };
}

function mockToolDefs(scenario: NonNullable<EvalCase['scenario']>): ToolDef[] {
  return scenario.tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters,
  }));
}

/** Connect to the named MCP server, discover its tools, and build a live resolver. */
async function wireMcp(serverId: string, deps: RunDeps): Promise<{ tools: ToolDef[]; resolver: ReturnType<typeof mcpResolver> }> {
  const config = (deps.mcpServers ?? []).find((s) => s.id === serverId);
  if (!config) throw new Error(`MCP server "${serverId}" is not configured`);
  const client = connectMcp(config, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  await client.connect();
  const discovered = await client.listTools();
  const tools: ToolDef[] = discovered.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.inputSchema,
  }));
  return { tools, resolver: mcpResolver(client, discovered) };
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

    const verdict = await judgeOutputEnsemble(systemPrompt, evalCase.input, generated.text, {
      provider: deps.judgeProvider,
      apiKey: deps.judgeKey,
      model: deps.judgeModel,
      rubric: deps.rubric,
      judgeSamples: deps.judgeSamples,
      judgeTemperature: deps.judgeTemperature,
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

/** Run one case `samples` times and fold to a single result with its spread. */
async function runCaseSampled(
  systemPrompt: string,
  evalCase: EvalCase,
  deps: RunDeps,
  samples: number,
  threshold: number,
): Promise<CaseResult> {
  const runs: CaseResult[] = [];
  for (let s = 0; s < samples; s++) runs.push(await runOneCase(systemPrompt, evalCase, deps));
  return foldSamples(runs, threshold);
}

/**
 * Run all cases, then summarize quality + speed. Cases run with bounded
 * concurrency (`deps.concurrency`, default 1 = sequential): a worker pool keeps
 * up to N in flight, so a large suite isn't gated on the slowest case one at a
 * time, while result ORDER is preserved. When `samples > 1`, each case is run
 * that many times and folded into one result with its run-to-run spread — so a
 * noisy score is visible, not hidden. Per-case failures are caught inside
 * `runOneCase`, so no single case can abort the run regardless of concurrency.
 */
export async function runEval(
  systemPrompt: string,
  cases: readonly EvalCase[],
  deps: RunDeps,
): Promise<RunOutcome> {
  const threshold = deps.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const samples = Math.max(1, Math.floor(deps.samples ?? 1));
  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? 1));
  const results = await mapWithConcurrency(cases, concurrency, (evalCase) =>
    runCaseSampled(systemPrompt, evalCase, deps, samples, threshold),
  );
  return { results, summary: summarizeRun(results, threshold) };
}
