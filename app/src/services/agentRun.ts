/**
 * Multi-turn agent loop (ADR 0002, slice a). Drives a model through a scenario:
 * model proposes tool calls → deterministic MOCK tools respond → results feed
 * back → repeat, until the model answers with no tool call or the step cap is
 * hit. Captures the full trajectory. The model turn is injected (`ModelStep`) so
 * the loop is unit-testable without provider multi-turn plumbing; a real adapter
 * supplies that step in slice a.2. No real tool is ever executed.
 */
import type { DimensionScore, MockResult, MockTool, Scenario, Timing, ToolCall } from '../shared/types';
import { validateArgsSchema } from './toolAssert';
import { round1 } from '../shared/num';

/** The growing conversation the loop maintains and hands to the model each turn. */
export interface AgentTurn {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  /** For a tool turn: which tool this result is for. */
  readonly toolName?: string;
}

/**
 * One model turn: the assistant's text plus any tool calls it requested, and
 * optionally the turn's timing. `timing` is optional so hand-written test steps
 * (and any non-provider step) need not synthesize one; a provider-backed step
 * supplies it so the trajectory's latency can be aggregated (run.ts).
 */
export type ModelStep = (
  turns: readonly AgentTurn[],
) => Promise<{ text: string; toolCalls: readonly ToolCall[]; timing?: Timing }>;

export interface ToolResultRecord {
  readonly name: string;
  readonly result: MockResult;
  /** Whether the called tool exists in the scenario catalog. */
  readonly known: boolean;
  /** Whether the call's arguments matched the tool's parameter schema. */
  readonly argsValid: boolean;
}

/**
 * Resolves one tool call to a result record (ADR 0003). This is the seam that
 * lets the same loop run against deterministic mocks OR a live MCP server: the
 * mock resolver (`defaultMockResolver`) replays scripted responses; the MCP
 * resolver (`services/toolResolver.ts`) issues a real `tools/call`. `perToolIndex`
 * is the 0-based count of prior calls to this same tool (mocks index into it).
 */
export type ToolResolver = (call: ToolCall, perToolIndex: number) => Promise<ToolResultRecord> | ToolResultRecord;

export interface AgentStep {
  readonly modelText: string;
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly ToolResultRecord[];
  /** This model turn's latency, when the step reported it (provider-backed runs). */
  readonly timing?: Timing;
}

export type StopReason = 'final' | 'max_steps' | 'aborted';

export interface Trajectory {
  readonly steps: readonly AgentStep[];
  readonly finalText: string;
  readonly stopReason: StopReason;
}

/** Resolve one mock tool call deterministically by per-tool call index. */
export function mockRespond(tool: MockTool | undefined, callIndex: number): { result: MockResult; known: boolean } {
  if (!tool) return { result: { error: 'unknown tool' }, known: false };
  if (tool.results.length === 0) return { result: { value: {} }, known: true };
  const idx = Math.min(callIndex, tool.results.length - 1);
  return { result: tool.results[idx] ?? { value: {} }, known: true };
}

function resultToContent(r: MockResult): string {
  return 'error' in r ? JSON.stringify({ error: r.error }) : JSON.stringify(r.value ?? {});
}

/**
 * The default tool resolver: deterministic mock tools from the scenario catalog
 * (ADR 0002 behaviour, factored out so the loop can take other resolvers).
 */
export function defaultMockResolver(scenario: Scenario): ToolResolver {
  const toolsByName = new Map(scenario.tools.map((t) => [t.name, t]));
  return (call, perToolIndex) => {
    const tool = toolsByName.get(call.name);
    const { result, known } = mockRespond(tool, perToolIndex);
    const argsValid = known && tool ? validateArgsSchema(call.arguments, tool.parameters).length === 0 : false;
    return { name: call.name, result, known, argsValid };
  };
}

/**
 * Run the agent loop over a scenario. Tool dispatch goes through `resolver`,
 * which defaults to the deterministic mock resolver so existing (ADR 0002) call
 * sites are unchanged; an MCP resolver is passed in for live-server runs.
 */
export async function runAgent(
  systemPrompt: string,
  scenario: Scenario,
  step: ModelStep,
  signal?: AbortSignal,
  resolver: ToolResolver = defaultMockResolver(scenario),
): Promise<Trajectory> {
  const callCounts = new Map<string, number>();
  const turns: AgentTurn[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: scenario.goal },
  ];
  const steps: AgentStep[] = [];

  for (let i = 0; i < scenario.maxSteps; i++) {
    if (signal?.aborted) return { steps, finalText: '', stopReason: 'aborted' };
    const { text, toolCalls, timing } = await step(turns);

    if (toolCalls.length === 0) {
      steps.push({ modelText: text, toolCalls: [], toolResults: [], ...(timing ? { timing } : {}) });
      return { steps, finalText: text, stopReason: 'final' };
    }

    const toolResults: ToolResultRecord[] = [];
    for (const c of toolCalls) {
      const n = callCounts.get(c.name) ?? 0;
      callCounts.set(c.name, n + 1);
      toolResults.push(await resolver(c, n));
    }

    steps.push({ modelText: text, toolCalls, toolResults, ...(timing ? { timing } : {}) });
    turns.push({ role: 'assistant', content: text, toolCalls });
    for (const tr of toolResults) turns.push({ role: 'tool', toolName: tr.name, content: resultToContent(tr.result) });
  }

  const last = steps[steps.length - 1];
  return { steps, finalText: last?.modelText ?? '', stopReason: 'max_steps' };
}

/** Whether the agent finished and produced the required answer. */
export function reachedGoal(trajectory: Trajectory, scenario: Scenario): { passed: boolean; reason: string } {
  if (trajectory.stopReason === 'aborted') return { passed: false, reason: 'run was aborted' };
  if (trajectory.stopReason === 'max_steps') return { passed: false, reason: `hit the ${scenario.maxSteps}-step cap without finishing` };
  const need = scenario.successContains ?? [];
  const text = trajectory.finalText.toLowerCase();
  const missing = need.filter((s) => !text.includes(s.toLowerCase()));
  if (missing.length > 0) return { passed: false, reason: `final answer missing: ${missing.join(', ')}` };
  return { passed: true, reason: 'reached the goal' };
}

export interface ScenarioVerdict {
  readonly passed: boolean;
  readonly score: number;
  readonly rationale: string;
  /** Per-dimension breakdown (also feeds the version litmus axis). */
  readonly dimensions: readonly DimensionScore[];
}

/**
 * Deterministic trajectory verdict (slice b), scored across five dimensions:
 *   goal_completion · tool_selection · argument_validity · recovery · efficiency
 * Fail-safe: if the goal wasn't completed the overall score is 0 (a wrong path
 * doesn't earn partial credit for tidy sub-steps). When it IS completed, the
 * overall is the mean of the dimensions, so a sloppy-but-successful run scores
 * below a clean one. Pass requires goal reached, only known tools, valid args.
 */
export function scoreScenario(trajectory: Trajectory, scenario: Scenario): ScenarioVerdict {
  const goal = reachedGoal(trajectory, scenario);
  const results = trajectory.steps.flatMap((s) => s.toolResults);
  const unknown = results.filter((r) => !r.known);
  const errors = results.filter((r) => 'error' in r.result);
  const badArgs = results.filter((r) => !r.argsValid);
  const stepsUsed = trajectory.steps.length;

  const goalScore = goal.passed ? 10 : 0;
  const toolSelection = results.length ? round1(((results.length - unknown.length) / results.length) * 10) : 10;
  const argumentValidity = results.length ? round1(((results.length - badArgs.length) / results.length) * 10) : 10;
  const recovery = errors.length === 0 ? 10 : goal.passed ? 10 : 0;
  const efficiency = goal.passed ? (stepsUsed <= Math.ceil(scenario.maxSteps / 2) ? 10 : 6) : 0;

  const dimensions: DimensionScore[] = [
    { dimension: 'goal_completion', score: goalScore },
    { dimension: 'tool_selection', score: toolSelection },
    { dimension: 'argument_validity', score: argumentValidity },
    { dimension: 'recovery', score: recovery },
    { dimension: 'efficiency', score: efficiency },
  ];
  const mean = round1(dimensions.reduce((a, d) => a + d.score, 0) / dimensions.length);
  const score = goal.passed ? mean : 0; // fail-safe
  const passed = goal.passed && unknown.length === 0 && badArgs.length === 0;

  const bits = [goal.reason, `${stepsUsed}/${scenario.maxSteps} steps`];
  if (unknown.length) bits.push(`${unknown.length} unknown-tool call(s): ${[...new Set(unknown.map((u) => u.name))].join(', ')}`);
  if (badArgs.length) bits.push(`${badArgs.length} invalid-argument call(s)`);
  if (errors.length) bits.push(`recovered from ${errors.length} tool error(s)`);
  return { passed, score, rationale: bits.join(' · '), dimensions };
}
