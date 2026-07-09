import { describe, it, expect } from 'vitest';
import { estimateRun, costForCall, exceedsCap, formatUsd, priceFor, DEFAULT_PRICE, mediaCostUsd, MEDIA_PRICES, SpendCapExceededError } from './cost';

describe('priceFor', () => {
  it('should fall back to the default for an unknown model', () => {
    expect(priceFor('mystery-model')).toBe(DEFAULT_PRICE);
  });
});

describe('costForCall', () => {
  it('should price input and output tokens separately', () => {
    // default: in 0.005/1k, out 0.015/1k → 1000 in + 500 out = 0.005 + 0.0075
    expect(costForCall('mystery', 1000, 500)).toBeCloseTo(0.0125, 6);
  });

  it('should clamp negative token counts to 0 (never a negative cost)', () => {
    expect(costForCall('mystery', -1000, -500)).toBe(0);
    // a negative input but positive output: only the output is priced
    expect(costForCall('mystery', -1000, 500)).toBeCloseTo(0.0075, 6);
  });
});

describe('estimateRun', () => {
  const base = {
    caseCount: 2,
    targetModel: 'mystery',
    judgeModel: 'mystery',
    analyzerModel: 'mystery',
    avgInputTokens: 1000,
    avgOutputTokens: 500,
  };

  it('should count run + judge calls and sum cost', () => {
    const e = estimateRun({ ...base, includeAnalysis: false, includeEvalGen: false, includeFixes: false });
    expect(e.totalCalls).toBe(4); // 2 generate + 2 judge
    expect(e.estUsd).toBeCloseTo(0.05, 6); // 4 * 0.0125
  });

  it('should add analysis, eval-gen, and fixes calls', () => {
    const e = estimateRun({ ...base, includeAnalysis: true, includeEvalGen: true, includeFixes: true });
    expect(e.totalCalls).toBe(7); // +1 +1 +1
    expect(e.estUsd).toBeCloseTo(0.0875, 6);
  });

  it('should omit judge calls for deterministic (tool/agent) runs', () => {
    const e = estimateRun({ ...base, includeAnalysis: false, includeEvalGen: false, includeFixes: false, includeJudge: false });
    expect(e.totalCalls).toBe(2); // 2 generate, 0 judge
    expect(e.estUsd).toBeCloseTo(0.025, 6); // 2 * 0.0125
  });

  it('should multiply judge calls by judgeSamples for an ensemble', () => {
    const e = estimateRun({ ...base, includeAnalysis: false, includeEvalGen: false, includeFixes: false, judgeSamples: 3 });
    expect(e.totalCalls).toBe(8); // 2 generate + 2 cases * 3 judges
    expect(e.estUsd).toBeCloseTo(0.1, 6); // 8 * 0.0125
  });

  it('should clamp negative case/token counts to 0 (no negative cost or weakened cap)', () => {
    const e = estimateRun({
      ...base,
      caseCount: -5,
      avgInputTokens: -1000,
      avgOutputTokens: -500,
      includeAnalysis: false,
      includeEvalGen: false,
      includeFixes: false,
    });
    expect(e.totalCalls).toBe(0); // caseCount clamped to 0 → 0 generate + 0 judge
    expect(e.estUsd).toBe(0);
  });
});

describe('exceedsCap', () => {
  it('should flag estimates over the cap', () => {
    expect(exceedsCap({ totalCalls: 4, estUsd: 0.6 }, 0.5)).toBe(true);
    expect(exceedsCap({ totalCalls: 4, estUsd: 0.4 }, 0.5)).toBe(false);
  });
});

describe('formatUsd', () => {
  it('should show cents normally and more precision for tiny amounts', () => {
    expect(formatUsd(0.18)).toBe('~$0.18');
    expect(formatUsd(0.0006)).toBe('~$0.0006');
  });
});

describe('media pricing (ADR 0007)', () => {
  it('should price each modality per artifact, with video the most expensive', () => {
    expect(mediaCostUsd('image')).toBe(MEDIA_PRICES.image);
    expect(mediaCostUsd('video')).toBeGreaterThan(mediaCostUsd('image'));
    expect(mediaCostUsd('video')).toBeGreaterThan(mediaCostUsd('voice'));
  });

  it('SpendCapExceededError should carry the spent + cap for the UI', () => {
    const err = new SpendCapExceededError(0.54, 0.1);
    expect(err.name).toBe('SpendCapExceededError');
    expect(err.spentUsd).toBe(0.54);
    expect(err.capUsd).toBe(0.1);
  });
});
