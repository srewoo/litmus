import { describe, it, expect } from 'vitest';
import { round1, clamp, mean, positiveCount } from './num';

describe('round1', () => {
  it('should round to one decimal place', () => {
    expect(round1(1.24)).toBe(1.2);
    expect(round1(1.25)).toBe(1.3);
  });
  it('should leave whole numbers unchanged', () => {
    expect(round1(9)).toBe(9);
  });
});

describe('clamp', () => {
  it('should clamp below the minimum', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });
  it('should clamp above the maximum', () => {
    expect(clamp(14, 0, 10)).toBe(10);
  });
  it('should pass through values in range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe('mean', () => {
  it('should average a list', () => {
    expect(mean([2, 4, 6])).toBe(4);
  });
  it('should return 0 for an empty list rather than NaN', () => {
    expect(mean([])).toBe(0);
  });
});

describe('positiveCount', () => {
  it('should pass finite counts >= 1 through, floored', () => {
    expect(positiveCount(1)).toBe(1);
    expect(positiveCount(3)).toBe(3);
    expect(positiveCount(2.9)).toBe(2);
  });
  it('should floor sub-1 and negative values up to 1', () => {
    expect(positiveCount(0)).toBe(1);
    expect(positiveCount(0.4)).toBe(1);
    expect(positiveCount(-5)).toBe(1);
  });
  it('should collapse non-finite counts to 1 (no hang / RangeError / zero runs)', () => {
    expect(positiveCount(NaN)).toBe(1);
    expect(positiveCount(Infinity)).toBe(1);
    expect(positiveCount(-Infinity)).toBe(1);
  });
});
