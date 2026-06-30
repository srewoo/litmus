import { describe, it, expect } from 'vitest';
import { runAgent, mockRespond, reachedGoal, scoreScenario } from './agentRun';
import type { AgentTurn, Trajectory } from './agentRun';
import type { MockTool, Scenario, Timing, ToolCall } from '../shared/types';

const weather: MockTool = {
  name: 'get_weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  results: [{ value: { tempC: 18 } }],
};

const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  goal: 'What should I wear in Paris?',
  tools: [weather],
  maxSteps: 4,
  ...over,
});

/** A scripted model: call the tool on turn 1, then answer on turn 2. */
function scriptedStep(script: ReadonlyArray<{ text: string; toolCalls: ToolCall[] }>) {
  let i = 0;
  return async (_turns: readonly AgentTurn[]) => script[i++] ?? { text: 'done', toolCalls: [] };
}

describe('mockRespond', () => {
  it('returns the result at the call index, repeating the last', () => {
    const t: MockTool = { name: 'f', parameters: {}, results: [{ value: 1 }, { value: 2 }] };
    expect(mockRespond(t, 0).result).toEqual({ value: 1 });
    expect(mockRespond(t, 1).result).toEqual({ value: 2 });
    expect(mockRespond(t, 5).result).toEqual({ value: 2 }); // last repeats
  });
  it('flags an unknown tool', () => {
    expect(mockRespond(undefined, 0)).toEqual({ result: { error: 'unknown tool' }, known: false });
  });
});

describe('runAgent', () => {
  it('loops: tool call → mock result → final answer', async () => {
    const step = scriptedStep([
      { text: 'let me check', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] },
      { text: 'Wear a light jacket.', toolCalls: [] },
    ]);
    const traj = await runAgent('SYS', scenario(), step);
    expect(traj.stopReason).toBe('final');
    expect(traj.finalText).toBe('Wear a light jacket.');
    expect(traj.steps).toHaveLength(2);
    expect(traj.steps[0]?.toolResults[0]).toMatchObject({ name: 'get_weather', known: true, result: { value: { tempC: 18 } } });
  });

  it('stops at the step cap when the model never finishes', async () => {
    const loop = async () => ({ text: 'thinking', toolCalls: [{ name: 'get_weather', arguments: {} }] });
    const traj = await runAgent('SYS', scenario({ maxSteps: 3 }), loop);
    expect(traj.stopReason).toBe('max_steps');
    expect(traj.steps).toHaveLength(3);
  });

  it('feeds a scripted tool error back and advances call index per tool', async () => {
    const flaky: MockTool = { name: 'pay', parameters: {}, results: [{ error: 'timeout' }, { value: { ok: true } }] };
    const captured: AgentTurn[][] = [];
    const step = (turns: readonly AgentTurn[]) => {
      captured.push([...turns]);
      return Promise.resolve(
        captured.length < 3
          ? { text: 'retry', toolCalls: [{ name: 'pay', arguments: {} }] }
          : { text: 'paid', toolCalls: [] },
      );
    };
    const traj = await runAgent('SYS', scenario({ tools: [flaky] }), step);
    expect(traj.steps[0]?.toolResults[0]?.result).toEqual({ error: 'timeout' });
    expect(traj.steps[1]?.toolResults[0]?.result).toEqual({ value: { ok: true } });
    // The error result was fed back into the conversation as a tool turn.
    expect(captured[1]?.some((t) => t.role === 'tool' && t.content.includes('timeout'))).toBe(true);
  });

  it('marks an unknown tool call', async () => {
    const step = scriptedStep([{ text: 'x', toolCalls: [{ name: 'nope', arguments: {} }] }, { text: 'end', toolCalls: [] }]);
    const traj = await runAgent('SYS', scenario(), step);
    expect(traj.steps[0]?.toolResults[0]).toMatchObject({ known: false, result: { error: 'unknown tool' } });
  });

  it('records each turn timing when the step reports it', async () => {
    const timing: Timing = { ttfbMs: 5, totalMs: 50, tokens: 12, tokensPerSec: 240 };
    const step = async (turns: readonly AgentTurn[]) =>
      turns.some((t) => t.role === 'tool')
        ? { text: 'Wear a light jacket.', toolCalls: [], timing }
        : { text: 'checking', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }], timing };
    const traj = await runAgent('SYS', scenario(), step);
    expect(traj.steps).toHaveLength(2);
    expect(traj.steps[0]?.timing).toEqual(timing);
    expect(traj.steps[1]?.timing).toEqual(timing);
  });

  it('omits timing on a step that does not report one (back-compat)', async () => {
    const step = scriptedStep([{ text: 'done', toolCalls: [] }]);
    const traj = await runAgent('SYS', scenario(), step);
    expect(traj.steps[0]?.timing).toBeUndefined();
  });

  it('aborts when the signal is already set', async () => {
    const ac = new AbortController();
    ac.abort();
    const traj = await runAgent('SYS', scenario(), async () => ({ text: 'x', toolCalls: [] }), ac.signal);
    expect(traj.stopReason).toBe('aborted');
  });
});

describe('reachedGoal', () => {
  it('passes a clean final answer', () => {
    expect(reachedGoal({ steps: [], finalText: 'all set', stopReason: 'final' }, scenario()).passed).toBe(true);
  });
  it('fails on the step cap', () => {
    expect(reachedGoal({ steps: [], finalText: '', stopReason: 'max_steps' }, scenario()).passed).toBe(false);
  });
  it('checks successContains case-insensitively', () => {
    const sc = scenario({ successContains: ['jacket'] });
    expect(reachedGoal({ steps: [], finalText: 'Wear a JACKET', stopReason: 'final' }, sc).passed).toBe(true);
    const bad = reachedGoal({ steps: [], finalText: 'wear shorts', stopReason: 'final' }, sc);
    expect(bad.passed).toBe(false);
    expect(bad.reason).toMatch(/missing: jacket/);
  });
});

describe('scoreScenario', () => {
  const traj = (over: Partial<Trajectory>): Trajectory => ({ steps: [], finalText: 'ok', stopReason: 'final', ...over });

  it('passes (10) when the goal is reached with only known, valid-arg tool calls', () => {
    const t = traj({ steps: [{ modelText: 'a', toolCalls: [], toolResults: [{ name: 'get_weather', result: { value: 1 }, known: true, argsValid: true }] }] });
    const v = scoreScenario(t, scenario());
    expect(v).toMatchObject({ passed: true, score: 10 });
    expect(v.dimensions.map((d) => d.dimension)).toContain('argument_validity');
  });

  it('finishes but loses points for calling an unknown tool', () => {
    const t = traj({ steps: [{ modelText: 'a', toolCalls: [], toolResults: [{ name: 'mystery', result: { error: 'unknown tool' }, known: false, argsValid: false }] }] });
    const v = scoreScenario(t, scenario());
    expect(v.passed).toBe(false);
    expect(v.score).toBeLessThan(10);
    expect(v.score).toBeGreaterThan(0); // goal reached → not a hard fail
    expect(v.dimensions.find((d) => d.dimension === 'tool_selection')?.score).toBe(0);
    expect(v.rationale).toMatch(/unknown-tool call\(s\): mystery/);
  });

  it('penalizes invalid arguments even on known tools', () => {
    const t = traj({ steps: [{ modelText: 'a', toolCalls: [], toolResults: [{ name: 'get_weather', result: { value: 1 }, known: true, argsValid: false }] }] });
    const v = scoreScenario(t, scenario());
    expect(v.passed).toBe(false);
    expect(v.dimensions.find((d) => d.dimension === 'argument_validity')?.score).toBe(0);
  });

  it('fail-safe: scores 0 when it never reached the goal, regardless of tidy sub-steps', () => {
    const v = scoreScenario(traj({ stopReason: 'max_steps' }), scenario({ maxSteps: 3 }));
    expect(v).toMatchObject({ passed: false, score: 0 });
    expect(v.rationale).toMatch(/3-step cap/);
  });

  it('counts only tool-use turns as steps: one tool call then a no-tool answer is 1 step', () => {
    // Step 0 issues a tool call; step 1 is the final no-tool answer turn. The
    // answer turn must NOT be counted toward the efficiency step total.
    const t = traj({
      steps: [
        { modelText: 'checking', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }], toolResults: [{ name: 'get_weather', result: { value: 1 }, known: true, argsValid: true }] },
        { modelText: 'Wear a jacket.', toolCalls: [], toolResults: [] },
      ],
    });
    const v = scoreScenario(t, scenario({ maxSteps: 4 }));
    expect(v.rationale).toMatch(/\b1\/4 steps\b/); // 1 tool step, not 2
    // 1 <= ceil(4/2)=2 → efficient
    expect(v.dimensions.find((d) => d.dimension === 'efficiency')?.score).toBe(10);
  });

  it('efficiency drops when tool-use turns exceed half the step cap (final answer excluded)', () => {
    const toolStep = (n: string) => ({ modelText: 'x', toolCalls: [{ name: 'get_weather', arguments: { city: n } }], toolResults: [{ name: 'get_weather', result: { value: 1 }, known: true, argsValid: true }] });
    const t = traj({
      steps: [toolStep('a'), toolStep('b'), toolStep('c'), { modelText: 'done', toolCalls: [], toolResults: [] }],
    });
    const v = scoreScenario(t, scenario({ maxSteps: 4 }));
    expect(v.rationale).toMatch(/\b3\/4 steps\b/); // 3 tool steps, answer excluded
    expect(v.dimensions.find((d) => d.dimension === 'efficiency')?.score).toBe(6);
  });
});
