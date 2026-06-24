import { describe, it, expect } from 'vitest';
import {
  esc,
  facetRowsHtml,
  casesListHtml,
  resultsTableHtml,
  fixesListHtml,
  versionsTimelineHtml,
  speedStripHtml,
  axisRowsHtml,
  coverageHtml,
  rubricHealthHtml,
} from './views';
import type { CaseResult, EvalCase, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 600, totalMs: 1600, tokens: 10, tokensPerSec: 94 };

describe('esc', () => {
  it('should escape HTML-significant characters', () => {
    expect(esc('<script>"&')).toBe('&lt;script&gt;&quot;&amp;');
  });
});

describe('facetRowsHtml', () => {
  it('should render each facet with its score and an icon, escaping the finding', () => {
    const html = facetRowsHtml([
      { facet: 'language', score: 8.5, finding: 'clear' },
      { facet: 'format', score: 4.8, finding: '<no schema>' },
      { facet: 'intent', score: 6.2, finding: 'implied' },
    ]);
    expect(html).toContain('Language');
    expect(html).toContain('8.5');
    expect(html).toContain('bar-hi'); // 8.5 → high band
    expect(html).toContain('bar-lo'); // 4.8 → low band
    expect(html).toContain('bar-mid'); // 6.2 → mid band
    expect(html).toContain('&lt;no schema&gt;');
  });
});

describe('casesListHtml', () => {
  it('should escape case input and tag the category', () => {
    const cases: EvalCase[] = [{ id: 'c1', category: 'adversarial', input: '<b>x</b>', pinned: false }];
    const html = casesListHtml(cases);
    expect(html).toContain('cat adv');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
  it('should show an empty state', () => {
    expect(casesListHtml([])).toContain('No cases');
  });
});

describe('resultsTableHtml', () => {
  it('should mark pass/fail and order failures first', () => {
    const results: CaseResult[] = [
      { caseId: 'pass', output: '', score: 9, passed: true, rationale: 'ok', timing },
      { caseId: 'fail', output: '', score: 3, passed: false, rationale: 'bad', timing },
    ];
    const html = resultsTableHtml(results, 6);
    expect(html.indexOf('fail')).toBeLessThan(html.indexOf('pass'));
    expect(html).toContain('pf f');
  });

  it('should show the case input as the detail when cases are provided', () => {
    const results: CaseResult[] = [
      { caseId: 'case-1', output: '', score: 9, passed: true, rationale: 'ok', timing },
    ];
    const cases = [
      { id: 'case-1', category: 'typical' as const, input: 'Refund my last order please', pinned: false },
    ];
    const html = resultsTableHtml(results, 6, cases);
    expect(html).toContain('Refund my last order please');
    expect(html).toContain('class="cid"');
    expect(html).toContain('case-1');
  });
});

describe('fixesListHtml', () => {
  it('should number fixes and cite the case', () => {
    expect(fixesListHtml([{ title: 'Add fallback', edit: 'do x', caseRef: 'c2' }])).toContain('Add fallback');
  });
  it('should show a clean empty state', () => {
    expect(fixesListHtml([])).toContain('No material weaknesses');
  });
});

describe('versionsTimelineHtml', () => {
  it('should render baseline and a delta', () => {
    const html = versionsTimelineHtml([
      { label: 'v1', note: 'baseline', overall: 6.8, passLabel: '9/12', avgSeconds: 1.6, delta: null, current: false },
      { label: 'v2', note: 'fixed', overall: 8.4, passLabel: '11/12', avgSeconds: 2.1, delta: 1.6, current: true },
    ]);
    expect(html).toContain('baseline');
    expect(html).toContain('▲ +1.6');
    expect(html).toContain('current');
  });
});

describe('axisRowsHtml', () => {
  it('should render diverging bars with both scores', () => {
    const html = axisRowsHtml([
      { dimension: 'Format', oldScore: 4.8, newScore: 9.6, oldWidthPct: 24, newWidthPct: 48, improved: true },
    ]);
    expect(html).toContain('Format');
    expect(html).toContain('4.8');
    expect(html).toContain('9.6');
    expect(html).toContain('width:48%');
  });
});

describe('coverageHtml', () => {
  it('should summarize coverage and flag NOT-TESTED gaps', () => {
    const html = coverageHtml([
      { instruction: 'Classify the ticket', dimension: 'instruction_adherence' },
      { instruction: 'Never reveal <secrets>', dimension: null },
    ]);
    expect(html).toContain('1/2 instructions covered');
    expect(html).toContain('NOT TESTED');
    expect(html).toContain('&lt;secrets&gt;'); // escaped
  });
});

describe('rubricHealthHtml', () => {
  it('should render discrimination and consistency', () => {
    const html = rubricHealthHtml({ discrimination: { gap: 2.3, rating: 'good' }, consistency: { stdDev: 0.4, rating: 'good' } });
    expect(html).toContain('Discrimination good (2.3)');
    expect(html).toContain('σ0.4');
  });
});

describe('speedStripHtml', () => {
  it('should convert ms to seconds', () => {
    expect(speedStripHtml({ ttfbMs: 600, avgResponseMs: 1600, tokensPerSec: 94 })).toContain('0.6s');
  });
});
