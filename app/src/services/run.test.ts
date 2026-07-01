import { describe, it, expect } from 'vitest';
import { runEval } from './run';
import type { RunDeps } from './run';
import type { Provider, ChatRequest, FetchLike, FetchResponse } from '../providers/types';
import type { EvalCase, Timing } from '../shared/types';
import type { McpServerConfig } from '../mcp/types';

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

  it('should reject (not resolve with partial results) when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runEval('SYS', cases, { ...baseDeps, signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('should stop issuing calls once cancelled mid-run', async () => {
    const ac = new AbortController();
    let targetCalls = 0;
    const cancelAfterFirst: Provider = {
      id: 'openai',
      async chat(req: ChatRequest) {
        targetCalls++;
        ac.abort(); // user hits Cancel during the first case
        return { text: `out:${req.messages.find((m) => m.role === 'user')?.content ?? ''}`, timing };
      },
    };
    // Sequential (concurrency 1) so the second case would only start after the
    // first returns — the abort gate must prevent that second target call.
    await expect(
      runEval('SYS', cases, { ...baseDeps, targetProvider: cancelAfterFirst, signal: ac.signal, concurrency: 1 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(targetCalls).toBe(1); // second case never dispatched
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

  it('should aggregate multi-turn timing across the trajectory (not zero)', async () => {
    const turnTiming: Timing = { ttfbMs: 50, totalMs: 200, tokens: 20, tokensPerSec: 100 };
    const agentTarget: Provider = {
      id: 'openai',
      async chat(req: ChatRequest) {
        const calledAlready = req.messages.some((m) => m.role === 'tool');
        return calledAlready
          ? { text: 'Wear a light jacket today.', timing: turnTiming }
          : { text: 'checking', timing: turnTiming, toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] };
      },
    };
    const scenarioCase: EvalCase = {
      id: 's1', category: 'typical', input: 'x', pinned: false,
      scenario: { goal: 'g', tools: [{ name: 'get_weather', description: 'current weather', parameters: { type: 'object' }, results: [{ value: { tempC: 16 } }] }], maxSteps: 4, successContains: ['jacket'] },
    };
    const { results, summary } = await runEval('SYS', [scenarioCase], { ...baseDeps, targetProvider: agentTarget });
    expect(results[0]?.timing.ttfbMs).toBe(50); // first turn's TTFB
    expect(results[0]?.timing.totalMs).toBe(400); // two turns × 200ms
    expect(summary.speed.avgResponseMs).toBe(400);
  });

  it('should run cases concurrently while preserving result order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: Provider = {
      id: 'openai',
      async chat(req: ChatRequest) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        const userTurn = req.messages.find((m) => m.role === 'user');
        return { text: `out:${userTurn?.content ?? ''}`, timing };
      },
    };
    const many: EvalCase[] = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, category: 'typical', input: `in${i}`, pinned: false }));
    const { results } = await runEval('SYS', many, { ...baseDeps, targetProvider: slow, concurrency: 3 });
    expect(results.map((r) => r.caseId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']); // order preserved
    expect(maxInFlight).toBeGreaterThan(1); // genuinely ran in parallel
    expect(maxInFlight).toBeLessThanOrEqual(3); // bounded by the limit
  });

  it('should carry per-dimension judge scores through to the case result', async () => {
    const dimJudge: Provider = {
      id: 'google',
      async chat() {
        return { text: '{"score":8,"rationale":"r","dimensions":[{"dimension":"format","score":9}]}', timing };
      },
    };
    const one: EvalCase[] = [{ id: 'c1', category: 'typical', input: 'good input', pinned: false }];
    const { results } = await runEval('SYS', one, { ...baseDeps, judgeProvider: dimJudge });
    expect(results[0]?.dimensions).toEqual([{ dimension: 'format', score: 9 }]);
  });

  it('should score a tool case deterministically even when no tool catalog is supplied', async () => {
    const toolTarget: Provider = {
      id: 'openai',
      async chat() {
        return { text: '', timing, toolCalls: [{ name: 'x', arguments: {} }] };
      },
    };
    const toolCases: EvalCase[] = [
      { id: 't1', category: 'adversarial', input: 'go', pinned: false, toolExpectations: { forbiddenTools: ['danger'] } },
    ];
    // No `tools` in deps → the request omits a catalog, but deterministic scoring still runs.
    const { results } = await runEval('SYS', toolCases, { ...baseDeps, targetProvider: toolTarget });
    expect(results[0]).toMatchObject({ caseId: 't1', passed: true });
  });

  it('should run an MCP-backed scenario: connect, discover tools, score the trajectory', async () => {
    // Fake JSON-RPC-over-HTTP server: answers initialize + tools/list; the agent
    // finishes on turn 1, so tools/call is never needed.
    const mcpFetch: FetchLike = async (_url, init) => {
      const msg = JSON.parse(init.body ?? '{}') as { id: number; method: string };
      const json = (result: unknown): FetchResponse => ({
        ok: true,
        status: 200,
        body: null,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }),
      });
      if (msg.method === 'initialize') {
        return json({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } });
      }
      // A described tool exercises the description-carry path in tool mapping.
      // One described tool and one without — covers both sides of the description-carry.
      if (msg.method === 'tools/list') return json({ tools: [{ name: 'get_weather', description: 'current weather', inputSchema: { type: 'object' } }, { name: 'get_time', inputSchema: { type: 'object' } }] });
      return { ok: true, status: 202, body: null, headers: { get: () => null }, text: async () => '' }; // notifications/initialized
    };
    const agentTarget: Provider = { id: 'openai', async chat() { return { text: 'Wear a jacket.', timing }; } };
    const servers: McpServerConfig[] = [{ id: 'srv', name: 'demo', url: 'https://h/mcp', transport: 'http' }];
    const scenarioCase: EvalCase = {
      id: 'm1', category: 'typical', input: 'x', pinned: false,
      scenario: { goal: 'g', tools: [], maxSteps: 3, successContains: ['jacket'], mcpServerId: 'srv' },
    };
    // Passing a signal exercises the signal-forwarding path into the MCP transport.
    const { results } = await runEval('SYS', [scenarioCase], {
      ...baseDeps,
      targetProvider: agentTarget,
      mcpServers: servers,
      fetchImpl: mcpFetch,
      // The origin was authorized earlier via the panel's Connect button.
      permissions: { contains: async () => true, request: async () => true },
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({ caseId: 'm1', passed: true });
  });

  it('should refuse an MCP-backed scenario whose origin is not authorized', async () => {
    const agentTarget: Provider = { id: 'openai', async chat() { return { text: 'Wear a jacket.', timing }; } };
    const servers: McpServerConfig[] = [{ id: 'srv', name: 'demo', url: 'https://h/mcp', transport: 'http' }];
    const scenarioCase: EvalCase = {
      id: 'm1', category: 'typical', input: 'x', pinned: false,
      scenario: { goal: 'g', tools: [], maxSteps: 3, successContains: ['jacket'], mcpServerId: 'srv' },
    };
    const { results } = await runEval('SYS', [scenarioCase], {
      ...baseDeps,
      targetProvider: agentTarget,
      mcpServers: servers,
      // Permission not held → the run must not connect or send the auth secret.
      permissions: { contains: async () => false, request: async () => false },
    });
    expect(results[0]).toMatchObject({ caseId: 'm1', passed: false });
    expect(results[0]?.rationale).toContain('not authorized');
  });

  it('should refuse tool/agent cases on a model that does not support tools', async () => {
    const toolCases: EvalCase[] = [
      { id: 't1', category: 'typical', input: 'weather?', pinned: false, toolExpectations: { expectedTool: 'get_weather' } },
    ];
    const { results } = await runEval('SYS', toolCases, {
      ...baseDeps,
      // claude-2 predates tool use → supportsTools is false.
      target: { provider: 'anthropic', model: 'claude-2.1' },
    });
    expect(results[0]).toMatchObject({ caseId: 't1', passed: false });
    expect(results[0]?.rationale).toContain('does not support tool');
  });

  it('should record a failed case when the provider throws a non-Error value', async () => {
    const odd: Provider = {
      id: 'openai',
      async chat() {
        throw 'boom'; // a non-Error throw — the catch must stringify it, not assume .message
      },
    };
    const { results } = await runEval('SYS', [{ id: 'c1', category: 'typical', input: 'x', pinned: false }], { ...baseDeps, targetProvider: odd });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.rationale).toContain('boom');
  });

  it('should record a scenario failure when its MCP server is not configured', async () => {
    const agentTarget: Provider = { id: 'openai', async chat() { return { text: 'hi', timing }; } };
    const scenarioCase: EvalCase = {
      id: 'm2', category: 'typical', input: 'x', pinned: false,
      scenario: { goal: 'g', tools: [], maxSteps: 2, mcpServerId: 'missing' },
    };
    const { results } = await runEval('SYS', [scenarioCase], { ...baseDeps, targetProvider: agentTarget });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.rationale).toMatch(/Run failed|not configured/);
  });

  it('should fold an ensemble judge to the median, resisting an outlier verdict', async () => {
    const scores = [9, 9, 2];
    let i = 0;
    const ensembleJudge: Provider = {
      id: 'google',
      async chat() {
        const s = scores[i++] ?? 9;
        return { text: `{"score":${s},"rationale":"r"}`, timing };
      },
    };
    const one: EvalCase[] = [{ id: 'c1', category: 'typical', input: 'good input', pinned: false }];
    const { results } = await runEval('SYS', one, { ...baseDeps, judgeProvider: ensembleJudge, judgeSamples: 3 });
    expect(i).toBe(3); // judged three times
    expect(results[0]?.score).toBe(9); // median(9,9,2)
    expect(results[0]?.rationale).toMatch(/median 9/);
  });

  it('should still report aggregated timing for an INCOMPLETE (max_steps) agent run', async () => {
    // Model never emits a final answer — it calls a tool every turn until the cap.
    const turnTiming: Timing = { ttfbMs: 30, totalMs: 150, tokens: 10, tokensPerSec: 66 };
    const looper: Provider = {
      id: 'openai',
      async chat() {
        return { text: 'still working', timing: turnTiming, toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] };
      },
    };
    const scenarioCase: EvalCase = {
      id: 'cap', category: 'typical', input: 'x', pinned: false,
      scenario: { goal: 'g', tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' }, results: [{ value: {} }] }], maxSteps: 3, successContains: ['jacket'] },
    };
    const { results } = await runEval('SYS', [scenarioCase], { ...baseDeps, targetProvider: looper });
    expect(results[0]?.passed).toBe(false); // hit the cap without finishing
    expect(results[0]?.timing.ttfbMs).toBe(30); // first turn's TTFB still surfaced
    expect(results[0]?.timing.totalMs).toBe(450); // 3 capped turns × 150ms — not zero
  });

  it('should isolate a throwing case under concurrency without aborting the others or reordering', async () => {
    const flaky: Provider = {
      id: 'openai',
      async chat(req: ChatRequest) {
        const userTurn = req.messages.find((m) => m.role === 'user');
        if (userTurn?.content.includes('in2')) throw new Error('boom on c2');
        return { text: `out:${userTurn?.content ?? ''}`, timing };
      },
    };
    const many: EvalCase[] = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, category: 'typical', input: `in${i}`, pinned: false }));
    const { results } = await runEval('SYS', many, { ...baseDeps, targetProvider: flaky, concurrency: 4 });
    expect(results.map((r) => r.caseId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']); // order preserved
    expect(results[2]?.passed).toBe(false); // the failed one is captured, not thrown
    expect(results[2]?.rationale).toMatch(/Run failed: boom on c2/);
    expect(results.filter((r) => r.passed)).toHaveLength(4); // the rest succeeded
  });

  it('should not hang or throw on a non-finite samples / concurrency count', async () => {
    const one: EvalCase[] = [{ id: 'c1', category: 'typical', input: 'good input', pinned: false }];
    // Infinity samples would spin `for (s = 0; s < Infinity; s++)` forever and
    // NaN concurrency would make the worker pool a no-op without the guards.
    const { results } = await runEval('SYS', one, {
      ...baseDeps,
      samples: Number.POSITIVE_INFINITY,
      concurrency: Number.NaN,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(9); // ran exactly once (collapsed to 1 sample)
    expect(results[0]?.samples).toBeUndefined(); // single run → no spread block
  });
});
