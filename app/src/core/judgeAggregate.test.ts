import { describe, it, expect } from 'vitest';
import { aggregateVerdicts, median } from './judgeAggregate';
import type { VerdictLike } from './judgeAggregate';

describe('median', () => {
  it('returns the middle of an odd-length list', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('averages the two middles of an even-length list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('aggregateVerdicts', () => {
  it('throws on an empty panel', () => {
    expect(() => aggregateVerdicts([])).toThrow(/no verdicts/);
  });

  it('returns a single verdict unchanged with no spread', () => {
    const v: VerdictLike = { score: 7, rationale: 'fine', dimensions: [{ dimension: 'tone', score: 8 }] };
    const out = aggregateVerdicts([v]);
    expect(out).toEqual({ score: 7, rationale: 'fine', dimensions: [{ dimension: 'tone', score: 8 }] });
    expect(out.spread).toBeUndefined();
  });

  it('drops an absent dimensions field for a lone verdict', () => {
    expect(aggregateVerdicts([{ score: 5, rationale: 'r' }]).dimensions).toBeUndefined();
  });

  it('rounds a single verdict score and dimensions to 1dp to match the median contract', () => {
    const out = aggregateVerdicts([
      { score: 7.26, rationale: 'r', dimensions: [{ dimension: 'tone', score: 6.04 }] },
    ]);
    expect(out.score).toBe(7.3);
    expect(out.dimensions).toEqual([{ dimension: 'tone', score: 6 }]);
    expect(out.spread).toBeUndefined();
  });

  it('takes the median score so a single outlier judge cannot swing the result', () => {
    const out = aggregateVerdicts([
      { score: 8, rationale: 'good' },
      { score: 8, rationale: 'good' },
      { score: 1, rationale: 'outlier' }, // would drag a mean to 5.7; median stays 8
    ]);
    expect(out.score).toBe(8);
    expect(out.spread).toMatchObject({ count: 3, min: 1, max: 8 });
  });

  it('surfaces disagreement in the rationale and spread', () => {
    const out = aggregateVerdicts([
      { score: 4, rationale: 'weak' },
      { score: 8, rationale: 'strong' },
    ]);
    expect(out.score).toBe(6); // median of [4,8]
    expect(out.rationale).toMatch(/2 judges: median 6 \(4–8/);
    expect(out.spread?.stdev).toBe(2);
  });

  it('keeps the rationale of the sample nearest the median, not an outlier', () => {
    // median([9,9,2]) = 9. first.rationale ('outlier') belongs to score 2 and
    // would contradict the reported 9 — the nearest-median sample must win.
    const out = aggregateVerdicts([
      { score: 2, rationale: 'outlier' },
      { score: 9, rationale: 'on the money' },
      { score: 9, rationale: 'also good' },
    ]);
    expect(out.score).toBe(9);
    expect(out.rationale).toMatch(/^on the money · /);
  });

  it('breaks a nearest-median tie by lowest index', () => {
    // median([4,8]) = 6; both are distance 2 from the median → lowest index wins.
    const out = aggregateVerdicts([
      { score: 4, rationale: 'weak' },
      { score: 8, rationale: 'strong' },
    ]);
    expect(out.rationale).toMatch(/^weak · /);
  });

  it('notes agreement when judges concur', () => {
    const out = aggregateVerdicts([
      { score: 9, rationale: 'a' },
      { score: 9, rationale: 'b' },
    ]);
    expect(out.rationale).toMatch(/judges agreed at 9/);
    expect(out.spread?.stdev).toBe(0);
  });

  it('medians each dimension across the panel, averaging only judges that scored it', () => {
    const out = aggregateVerdicts([
      { score: 7, rationale: 'a', dimensions: [{ dimension: 'tone', score: 6 }, { dimension: 'format', score: 4 }] },
      { score: 9, rationale: 'b', dimensions: [{ dimension: 'tone', score: 8 }] },
      { score: 8, rationale: 'c', dimensions: [{ dimension: 'tone', score: 10 }, { dimension: 'format', score: 6 }] },
    ]);
    // tone: median(6,8,10)=8 ; format: median(4,6)=5 ; order preserved (tone first)
    expect(out.dimensions).toEqual([
      { dimension: 'tone', score: 8 },
      { dimension: 'format', score: 5 },
    ]);
  });
});
