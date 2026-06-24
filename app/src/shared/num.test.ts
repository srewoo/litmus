import { describe, it, expect } from 'vitest';
import { round1, clamp, mean } from './num';

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
