import { describe, it, expect } from 'vitest';
import { stdDev, consistency, discrimination } from './rubric';

describe('stdDev', () => {
  it('should be 0 for fewer than two samples', () => {
    expect(stdDev([])).toBe(0);
    expect(stdDev([5])).toBe(0);
  });
  it('should compute population standard deviation', () => {
    expect(stdDev([2, 4, 6])).toBeCloseTo(1.633, 2);
  });
});

describe('consistency', () => {
  it('should rate tight repeat scores as good', () => {
    expect(consistency([8.0, 8.2, 8.1])).toMatchObject({ rating: 'good' });
  });
  it('should rate moderate spread as fair', () => {
    expect(consistency([7, 8.4]).rating).toBe('fair'); // sd 0.7
  });
  it('should rate wide repeat scores as poor', () => {
    expect(consistency([3, 7, 9]).rating).toBe('poor');
  });
});

describe('discrimination', () => {
  it('should rate a wide easy-vs-hard gap as good', () => {
    expect(discrimination([9, 9, 8], [3, 4, 2])).toMatchObject({ rating: 'good' });
  });
  it('should rate a moderate gap as fair', () => {
    expect(discrimination([8], [7]).rating).toBe('fair'); // gap 1.0
  });
  it('should rate little separation as poor', () => {
    expect(discrimination([7, 7], [6.8, 7]).rating).toBe('poor');
  });
});
