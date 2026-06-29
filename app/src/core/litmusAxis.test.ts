import { describe, it, expect } from 'vitest';
import { scoreToHalfWidth, buildAxis, overallDelta, describeComparison } from './litmusAxis';
import type { DimensionScore } from '../shared/types';

describe('scoreToHalfWidth', () => {
  it('should map 0–10 onto a 0–50% half track', () => {
    expect(scoreToHalfWidth(0)).toBe(0);
    expect(scoreToHalfWidth(10)).toBe(50);
    expect(scoreToHalfWidth(5)).toBe(25);
  });
  it('should clamp out-of-range scores', () => {
    expect(scoreToHalfWidth(12)).toBe(50);
    expect(scoreToHalfWidth(-2)).toBe(0);
  });
});

describe('buildAxis', () => {
  const oldDims: DimensionScore[] = [
    { dimension: 'Intent', score: 6.2 },
    { dimension: 'Format', score: 4.8 },
  ];

  it('should pair old and new scores per dimension and flag improvement', () => {
    const newDims: DimensionScore[] = [
      { dimension: 'Intent', score: 9.4 },
      { dimension: 'Format', score: 9.6 },
    ];
    const rows = buildAxis(oldDims, newDims);
    expect(rows[0]).toMatchObject({ dimension: 'Intent', oldScore: 6.2, newScore: 9.4, improved: true });
    expect(rows[1]?.newWidthPct).toBe(48); // 9.6/10*50
  });

  it('should keep the old score when a dimension is missing from the new set', () => {
    const rows = buildAxis(oldDims, [{ dimension: 'Intent', score: 8 }]);
    expect(rows[1]).toMatchObject({ dimension: 'Format', oldScore: 4.8, newScore: 4.8, improved: false });
  });

  it('should not flag a regression as improved', () => {
    const rows = buildAxis([{ dimension: 'Tone', score: 8 }], [{ dimension: 'Tone', score: 6 }]);
    expect(rows[0]?.improved).toBe(false);
  });
});

describe('overallDelta', () => {
  it('should return a positive signed delta on improvement', () => {
    expect(overallDelta(6.8, 9.1)).toBe(2.3);
  });
  it('should return a negative delta on regression', () => {
    expect(overallDelta(8, 7.4)).toBe(-0.6);
  });
});

describe('describeComparison', () => {
  const base = { label: 'v1', promptText: 'You are a helpful assistant.', model: 'gpt-5.5' };

  it('should classify identical prompt on different models as a model comparison', () => {
    const c = describeComparison(base, { label: 'v2', promptText: base.promptText, model: 'claude-opus-4-8' });
    expect(c.kind).toBe('model');
    expect(c.header).toBe('Model · gpt-5.5 vs claude-opus-4-8');
  });

  it('should classify a changed prompt on the same model as a prompt comparison', () => {
    const c = describeComparison(base, { label: 'v2', promptText: 'You are a terse assistant.', model: 'gpt-5.5' });
    expect(c.kind).toBe('prompt');
    expect(c.header).toBe('Prompt · v1 → v2');
  });

  it('should classify a changed prompt AND model as both', () => {
    const c = describeComparison(base, { label: 'v2', promptText: 'Different.', model: 'gemini-3.5-pro' });
    expect(c.kind).toBe('both');
    expect(c.header).toContain('prompt + model');
    expect(c.header).toContain('gpt-5.5 vs gemini-3.5-pro');
  });

  it('should report same when prompt and model are identical', () => {
    const c = describeComparison(base, { label: 'v2', promptText: base.promptText, model: 'gpt-5.5' });
    expect(c.kind).toBe('same');
  });

  it('should not treat a missing model on either side as a model change', () => {
    const c = describeComparison(
      { label: 'v1', promptText: 'p' },
      { label: 'v2', promptText: 'p', model: 'gpt-5.5' },
    );
    expect(c.kind).toBe('same');
  });
});
