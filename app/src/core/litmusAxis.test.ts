import { describe, it, expect } from 'vitest';
import { scoreToHalfWidth, buildAxis, overallDelta } from './litmusAxis';
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
