import { describe, it, expect } from 'vitest';
import { runEval } from './run';
import type { RunDeps } from './run';
import { mediaCaseResult, type MediaGenerator } from './mediaRun';
import type { Provider, ChatRequest } from '../providers/types';
import type { EvalCase, Timing } from '../shared/types';
import type { MediaSignals } from '../shared/media';
import { mediaCostUsd } from '../core/cost';

const timing: Timing = { ttfbMs: 50, totalMs: 800, tokens: 0, tokensPerSec: 0 };

const unusedProvider: Provider = {
  id: 'openai',
  async chat(_req: ChatRequest) {
    throw new Error('media cases must not call the chat provider');
  },
};

const baseDeps: RunDeps = {
  target: { provider: 'openai', model: 'gpt-image-1' },
  targetProvider: unusedProvider,
  targetKey: 'sk-t',
  judgeProvider: unusedProvider,
  judgeKey: 'sk-j',
  judgeModel: 'x',
};

const imageCase: EvalCase = {
  id: 'img1',
  category: 'typical',
  input: 'a red cube',
  pinned: false,
  media: { kind: 'image', width: 512, height: 512, mustContain: ['cube'] },
};

/** Stub generator returning fixed signals — the ADR-0007 "stub generation + stub checkers" E2E. */
function stubGenerator(signals: MediaSignals): MediaGenerator {
  return async () => ({ signals, timing });
}

const goodImage: MediaSignals = {
  kind: 'image', decoded: true, width: 512, height: 512, format: 'png', count: 1,
  safetyBlocked: false, labels: ['a red cube'], ocrText: '',
};

describe('mediaCaseResult', () => {
  it('should produce a passing CaseResult with dimensions from a good artifact', async () => {
    const r = await mediaCaseResult('SYS', imageCase, stubGenerator(goodImage));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(10);
    expect(r.caseId).toBe('img1');
    expect(r.dimensions?.some((d) => d.dimension === 'object_presence')).toBe(true);
  });

  it('should produce a failing CaseResult when a gate breaks', async () => {
    const r = await mediaCaseResult('SYS', imageCase, stubGenerator({ ...goodImage, width: 256 }));
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.rationale).toMatch(/Image check failed/);
  });

  it('should forward an AbortSignal to the generator and omit dimensions when there are no content checks', async () => {
    const gateOnlyCase: EvalCase = {
      id: 'g1', category: 'typical', input: 'a 512px image', pinned: false,
      media: { kind: 'image', width: 512 }, // only a hard gate, no content checks
    };
    let sawSignal = false;
    const gen: MediaGenerator = async (_c, ctx) => {
      sawSignal = ctx.signal !== undefined;
      return { signals: goodImage, timing };
    };
    const ac = new AbortController();
    const r = await mediaCaseResult('SYS', gateOnlyCase, gen, ac.signal);
    expect(sawSignal).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.dimensions).toBeUndefined(); // no content checks → no dimensions block
  });

  it('should append the frame coverage note for video', async () => {
    const videoCase: EvalCase = { id: 'v1', category: 'typical', input: 'clip', pinned: false, media: { kind: 'video' } };
    const sig: MediaSignals = {
      kind: 'video', decoded: true, durationSec: 5, width: 1280, height: 720, fps: 24, format: 'mp4',
      hasAudio: false, frameCount: 120, sampledFrames: 12, flicker: 0.05, labels: [], safetyBlocked: false,
    };
    const r = await mediaCaseResult('SYS', videoCase, stubGenerator(sig));
    expect(r.rationale).toMatch(/sampled 12\/120 frame/);
  });
});

describe('runEval media integration (ADR 0007)', () => {
  it('should route media cases through the generator, not the chat provider', async () => {
    const { results, summary } = await runEval('SYS', [imageCase], { ...baseDeps, mediaGenerator: stubGenerator(goodImage) });
    expect(results[0]?.passed).toBe(true);
    expect(summary.passCount).toBe(1);
  });

  it('should record a clear failure when no media generator is configured', async () => {
    const { results } = await runEval('SYS', [imageCase], baseDeps);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.rationale).toMatch(/requires a configured media generator/);
  });

  it('should STOP before a case that would exceed the spend cap and reject (no partial run)', async () => {
    const cases: EvalCase[] = [
      { ...imageCase, id: 'a' },
      { id: 'b', category: 'typical', input: 'clip', pinned: false, media: { kind: 'video' } },
      { ...imageCase, id: 'c' },
    ];
    let generated = 0;
    const countingGen: MediaGenerator = async (c) => {
      generated++;
      const sig = c.media?.kind === 'video'
        ? ({ kind: 'video', decoded: true, durationSec: 5, width: 1280, height: 720, fps: 24, format: 'mp4', hasAudio: false, frameCount: 30, sampledFrames: 5, flicker: 0.05, labels: [], safetyBlocked: false } as MediaSignals)
        : goodImage;
      return { signals: sig, timing };
    };
    // cap just above one image ($0.04) but below image+video ($0.04 + $0.50).
    await expect(
      runEval('SYS', cases, {
        ...baseDeps,
        mediaGenerator: countingGen,
        budget: { capUsd: 0.1, costOf: (c) => (c.media ? mediaCostUsd(c.media.kind) : 0) },
      }),
    ).rejects.toMatchObject({ name: 'SpendCapExceededError' });
    // Only the first (image) case ran before the video tripped the cap.
    expect(generated).toBe(1);
  });

  it('should complete when the cap comfortably covers every case', async () => {
    const cases: EvalCase[] = [{ ...imageCase, id: 'a' }, { ...imageCase, id: 'b' }];
    const { summary } = await runEval('SYS', cases, {
      ...baseDeps,
      mediaGenerator: stubGenerator(goodImage),
      budget: { capUsd: 1, costOf: (c) => (c.media ? mediaCostUsd(c.media.kind) : 0) },
    });
    expect(summary.total).toBe(2);
    expect(summary.passCount).toBe(2);
  });
});
