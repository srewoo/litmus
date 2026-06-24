import { describe, it, expect } from 'vitest';
import { aggregateDimensions } from './dimensions';
import type { CaseResult, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };
const r = (dims: Array<{ dimension: string; score: number }>): CaseResult => ({
  caseId: 'c',
  output: '',
  score: 7,
  passed: true,
  rationale: '',
  timing,
  dimensions: dims,
});

describe('aggregateDimensions', () => {
  it('should average each dimension across cases', () => {
    const out = aggregateDimensions([
      r([{ dimension: 'format', score: 8 }, { dimension: 'intent', score: 6 }]),
      r([{ dimension: 'format', score: 6 }, { dimension: 'intent', score: 9 }]),
    ]);
    expect(out).toContainEqual({ dimension: 'format', score: 7 });
    expect(out).toContainEqual({ dimension: 'intent', score: 7.5 });
  });
  it('should return an empty list when no case has dimensions', () => {
    const noDims: CaseResult = { caseId: 'c', output: '', score: 5, passed: false, rationale: '', timing };
    expect(aggregateDimensions([noDims])).toEqual([]);
  });
});
