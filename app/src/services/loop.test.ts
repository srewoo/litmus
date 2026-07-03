import { describe, it, expect } from 'vitest';
import { runLoopPass } from './loop';
import type { LoopDeps } from './loop';
import { InMemoryStore } from '../platform/store';
import type { Provider, ChatRequest } from '../providers/types';
import type { Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 100, totalMs: 1000, tokens: 10, tokensPerSec: 10 };

/** Target echoes input; judge scores by keyword; aux returns cases or fixes by intent. */
const targetProvider: Provider = {
  id: 'openai',
  async chat(req: ChatRequest) {
    const u = req.messages.find((m) => m.role === 'user')?.content ?? '';
    return { text: `out:${u}`, timing };
  },
};

const auxProvider: Provider = {
  id: 'google',
  async chat(req: ChatRequest) {
    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
    if (sys.includes('evaluation designer')) {
      return {
        text: JSON.stringify({
          cases: [
            { category: 'typical', input: 'easy one' },
            { category: 'adversarial', input: 'bad one' },
          ],
        }),
        timing,
      };
    }
    if (sys.includes('output judge')) {
      const out = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const score = out.includes('bad one') ? 3 : 9;
      return { text: `{"score":${score},"rationale":"r"}`, timing };
    }
    if (sys.includes('prompt-improvement')) {
      return { text: '{"fixes":[{"title":"Handle the edge","edit":"add rule","caseRef":"case-2"}]}', timing };
    }
    return { text: '{}', timing };
  },
};

const deps: LoopDeps = {
  target: { provider: 'openai', model: 'gpt-5.1' },
  targetProvider,
  targetKey: 'sk-t',
  judgeProvider: auxProvider,
  judgeKey: 'sk-a',
  auxModel: 'gemini-2.5-pro',
  store: new InMemoryStore(),
  makeVersionId: (i) => `v${i}`,
  now: 1000,
};

describe('runLoopPass', () => {
  it('should generate cases, run, judge, suggest fixes, and save v1', async () => {
    const store = new InMemoryStore();
    const result = await runLoopPass(
      { systemPrompt: 'You are a bot.', note: 'baseline' },
      { ...deps, store },
    );

    expect(result.version.id).toBe('v1');
    expect(result.version.index).toBe(1);
    expect(result.cases).toHaveLength(2);
    expect(result.outcome.summary.total).toBe(2);
    expect(result.outcome.summary.passCount).toBe(1); // "bad one" fails
    expect(result.fixes[0]?.caseRef).toBe('case-2');

    // Persisted
    expect((await store.getVersions()).map((v) => v.id)).toEqual(['v1']);
    expect((await store.getRun('v1'))?.summary.overall).toBe(6);
  });

  it('should increment the version index on a second pass and reuse provided cases', async () => {
    const store = new InMemoryStore();
    await runLoopPass({ systemPrompt: 'v1 prompt', note: 'baseline' }, { ...deps, store });
    const second = await runLoopPass(
      {
        systemPrompt: 'v2 prompt',
        note: 'fixed',
        parentId: 'v1',
        cases: [{ id: 'case-1', category: 'typical', input: 'easy one', pinned: false }],
      },
      { ...deps, store },
    );
    expect(second.version.index).toBe(2);
    expect(second.version.parentId).toBe('v1');
    expect(second.cases).toHaveLength(1); // reused, not regenerated
  });

  it('should still persist the version + run when the fixer throws, degrading to empty fixes', async () => {
    const store = new InMemoryStore();
    // Judge/aux provider that scores cases but throws for the fixer step, so a
    // fully-paid eval must not be lost to an (advisory) fixer failure.
    const flakyFixer: Provider = {
      id: 'google',
      async chat(req: ChatRequest) {
        const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
        if (sys.includes('prompt-improvement')) throw new Error('fixer boom');
        return auxProvider.chat(req, { apiKey: 'sk-a' });
      },
    };
    const result = await runLoopPass(
      { systemPrompt: 'You are a bot.', note: 'baseline' },
      { ...deps, store, judgeProvider: flakyFixer },
    );

    expect(result.fixes).toEqual([]); // degraded, not thrown
    // The version + run are still persisted despite the fixer failure.
    expect((await store.getVersions()).map((v) => v.id)).toEqual(['v1']);
    expect((await store.getRun('v1'))?.summary.total).toBe(2);
  });
});
