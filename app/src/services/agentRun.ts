/**
 * Multi-turn agent loop (ADR 0002, slice a). Drives a model through a scenario:
 * model proposes tool calls → deterministic MOCK tools respond → results feed
 * back → repeat, until the model answers with no tool call or the step cap is
 * hit. Captures the full trajectory. The model turn is injected (`ModelStep`) so
 * the loop is unit-testable without provider multi-turn plumbing; a real adapter
 * supplies that step in slice a.2. No real tool is ever executed.
 */
import type { DimensionScore, MockResult, MockTool, Scenario, ToolCall } from '../shared/types';
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

/** One model turn: the assistant's text plus any tool calls it requested. */
export type ModelStep = (turns: readonly AgentTurn[]) => Promise<{ text: string; toolCalls: readonly ToolCall[] }>;

export interface ToolResultRecord {
  readonly name: string;
  readonly result: MockResult;
  /** Whether the called tool exists in the scenario catalog. */
  readonly known: boolean;
  /** Whether the call's arguments matched the tool's parameter schema. */
  readonly argsValid: boolean;
}

export interface AgentStep {
  readonly modelText: string;
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly ToolResultRecord[];
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

/** Run the agent loop over a scenario. */
export async function runAgent(
  systemPrompt: string,
  scenario: Scenario,
  step: ModelStep,
  signal?: AbortSignal,
): Promise<Trajectory> {
  const toolsByName = new Map(scenario.tools.map((t) => [t.name, t]));
  const callCounts = new Map<string, number>();
  const turns: AgentTurn[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: scenario.goal },
  ];
  const steps: AgentStep[] = [];

  for (let i = 0; i < scenario.maxSteps; i++) {
    if (signal?.aborted) return { steps, finalText: '', stopReason: 'aborted' };
    const { text, toolCalls } = await step(turns);

    if (toolCalls.length === 0) {
      steps.push({ modelText: text, toolCalls: [], toolResults: [] });
      return { steps, finalText: text, stopReason: 'final' };
    }

    const toolResults: ToolResultRecord[] = toolCalls.map((c) => {
      const n = callCounts.get(c.name) ?? 0;
      callCounts.set(c.name, n + 1);
      const tool = toolsByName.get(c.name);
      const { result, known } = mockRespond(tool, n);
      const argsValid = known && tool ? validateArgsSchema(c.arguments, tool.parameters).length === 0 : false;
      return { name: c.name, result, known, argsValid };
    });

    steps.push({ modelText: text, toolCalls, toolResults });
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
