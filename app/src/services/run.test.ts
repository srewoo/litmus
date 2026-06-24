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
});
