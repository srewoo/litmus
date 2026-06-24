import { describe, it, expect } from 'vitest';
import { runEval } from './run';
import type { RunDeps } from './run';
import type { Provider, ChatRequest } from '../providers/types';
import type { EvalCase, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 100, totalMs: 1000, tokens: 10, tokensPerSec: 10 };

const cases: EvalCase[] = [
  { id: 'c1', category: 'typical', input: 'good input', pinned: false },
  { id: 'c2', category: 'edge', input: 'bad input', pinned: false },
];

/** Target echoes the input so the judge can branch on it. */
const targetProvider: Provider = {
  id: 'openai',
  async chat(req: ChatRequest) {
    const userTurn = req.messages.find((m) => m.role === 'user');
    return { text: `out:${userTurn?.content ?? ''}`, timing };
  },
};

/** Judge: high score unless the output came from "bad input". */
const judgeProvider: Provider = {
  id: 'google',
  async chat(req: ChatRequest) {
    const score = req.messages.some((m) => m.content.includes('bad input')) ? 3 : 9;
    return { text: `{"score":${score},"rationale":"r"}`, timing };
  },
};

const baseDeps: RunDeps = {
  target: { provider: 'openai', model: 'gpt-5.1' },
  targetProvider,
  targetKey: 'sk-t',
  judgeProvider,
  judgeKey: 'sk-j',
  judgeModel: 'gemini-2.5-pro',
};

describe('runEval', () => {
  it('should generate, judge, and summarize each case', async () => {
    const { results, summary } = await runEval('SYS', cases, baseDeps);
    expect(results).toHaveLength(2);
    expect(results[0]?.score).toBe(9);
    expect(results[1]?.score).toBe(3);
    expect(summary.passCount).toBe(1);
    expect(summary.failCount).toBe(1);
    expect(summary.overall).toBe(6); // mean(9,3)
  });

  it('should record a failed case without aborting the run', async () => {
    const flaky: Provider = {
      id: 'openai',
      async chat(req: ChatRequest) {
        if (req.messages.some((m) => m.content.includes('bad input'))) throw new Error('429 rate limited');
        return { text: 'out', timing };
      },
    };
    const { results } = await runEval('SYS', cases, { ...baseDeps, targetProvider: flaky });
    expect(results).toHaveLength(2);
    expect(results[1]?.passed).toBe(false);
    expect(results[1]?.rationale).toContain('Run failed');
  });

  it('should score a tool-expectation case deterministically, sending tools and skipping the judge', async () => {
    let sawTools = false;
    let judgeCalled = false;
    const toolTarget: Provider = {
      id: 'openai',
      async chat(req: ChatRequest) {
        if (req.tools?.length) sawTools = true;
        return { text: '', timing, toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] };
      },
    };
    const noJudge: Provider = {
      id: 'google',
      async chat() {
        judgeCalled = true;
        return { text: '{"score":1,"rationale":"should not run"}', timing };
      },
    };
    const toolCases: EvalCase[] = [
      { id: 't1', category: 'typical', input: 'weather in Paris?', pinned: false, toolExpectations: { expectedTool: 'get_weather' } },
      { id: 't2', category: 'adversarial', input: 'delete everything', pinned: false, toolExpectations: { forbiddenTools: ['get_weather'] } },
    ];
    const { results, summary } = await runEval('SYS', toolCases, {
      ...baseDeps,
      targetProvider: toolTarget,
      judgeProvider: noJudge,
      tools: [{ name: 'get_weather', parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } } }],
    });
    expect(sawTools).toBe(true);
    expect(judgeCalled).toBe(false); // tool cases never reach the judge
    expect(results[0]).toMatchObject({ caseId: 't1', passed: true, score: 10 });
    expect(results[1]).toMatchObject({ caseId: 't2', passed: false, score: 0 });
    expect(results[1]?.rationale).toMatch(/forbidden tool "get_weather"/);
    expect(summary.passCount).toBe(1);
  });

  it('should run a multi-turn agent scenario and score its trajectory', async () => {
    // Target: call the tool on turn 1, then answer with the success keyword on turn 2.
    const agentTarget: Provider = {
      id: 'openai',
      async chat(req: ChatRequest) {
        const calledAlready = req.messages.some((m) => m.role === 'tool');
        return calledAlready
          ? { text: 'Wear a light jacket today.', timing }
          : { text: 'checking', timing, toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] };
      },
    };
    const scenarioCase: EvalCase = {
      id: 's1',
      category: 'typical',
      input: 'What should I wear in Paris?',
      pinned: false,
      scenario: {
        goal: 'What should I wear in Paris?',
        tools: [{ name: 'get_weather', parameters: { type: 'object' }, results: [{ value: { tempC: 16 } }] }],
        maxSteps: 4,
        successContains: ['jacket'],
      },
    };
    const { results } = await runEval('SYS', [scenarioCase], { ...baseDeps, targetProvider: agentTarget });
    expect(results[0]).toMatchObject({ caseId: 's1', passed: true, score: 10 });
    expect(results[0]?.rationale).toMatch(/reached the goal/);
  });
});
