import { describe, it, expect } from 'vitest';
import {
  esc,
  facetRowsHtml,
  suggestionsHtml,
  casesListHtml,
  resultsTableHtml,
  caseDetailHtml,
  fixesListHtml,
  versionsTimelineHtml,
  speedStripHtml,
  axisRowsHtml,
  axisHeaderHtml,
  coverageHtml,
  rubricHealthHtml,
  builderLogHtml,
} from './views';
import type { BuilderTurnVM } from './views';
import type { CaseResult, EvalCase, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 600, totalMs: 1600, tokens: 10, tokensPerSec: 94 };

describe('caseDetailHtml', () => {
  const base = { caseId: 'case-1', score: 0, passed: false, rationale: 'because reasons', timing };

  it('shows the question and the model response for a quality case', () => {
    const c: EvalCase = { id: 'case-1', category: 'typical', input: 'What is 2+2?', pinned: false };
    const html = caseDetailHtml({ ...base, output: 'The answer is 4.' }, c);
    expect(html).toContain('Question');
    expect(html).toContain('What is 2+2?');
    expect(html).toContain('The answer is 4.');
    expect(html).toContain('because reasons'); // full rationale, not truncated
    expect(html).toContain('mdetail hidden'); // collapsed by default
  });

  it('lists the tools called for a tool case', () => {
    const c: EvalCase = { id: 'case-1', category: 'typical', input: 'weather in Paris?', pinned: false, toolExpectations: { expectedTool: 'get_weather' } };
    const output = JSON.stringify([{ name: 'get_weather', arguments: { city: 'Paris' } }]);
    const html = caseDetailHtml({ ...base, output }, c);
    expect(html).toContain('Tools called');
    expect(html).toContain('get_weather');
    expect(html).toContain('Paris');
    expect(html).toContain('expected: get_weather');
  });

  it('renders the trajectory and final answer for an agent scenario', () => {
    const c: EvalCase = {
      id: 'case-1',
      category: 'typical',
      input: 'umbrella?',
      pinned: false,
      scenario: { goal: 'umbrella?', tools: [], maxSteps: 3 },
    };
    const traj = {
      steps: [{ modelText: 'checking', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }], toolResults: [{ name: 'get_weather', result: { value: { rain: true } } }] }],
      finalText: 'Yes, bring an umbrella.',
      stopReason: 'final',
    };
    const html = caseDetailHtml({ ...base, output: JSON.stringify(traj), dimensions: [{ dimension: 'goal_completion', score: 10 }] }, c);
    expect(html).toContain('Trajectory');
    expect(html).toContain('get_weather');
    expect(html).toContain('Final answer');
    expect(html).toContain('Yes, bring an umbrella.');
    expect(html).toContain('goal_completion');
  });

  it('escapes malicious output', () => {
    const c: EvalCase = { id: 'case-1', category: 'typical', input: '<img src=x>', pinned: false };
    const html = caseDetailHtml({ ...base, output: '<script>alert(1)</script>' }, c);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('esc', () => {
  it('should escape HTML-significant characters', () => {
    expect(esc('<script>"&')).toBe('&lt;script&gt;&quot;&amp;');
  });
});

describe('suggestionsHtml', () => {
  it('should render each suggestion in its own row', () => {
    const html = suggestionsHtml(['Tighten the tone', 'Add an output schema']);
    expect(html).toContain('✦ Tighten the tone');
    expect(html).toContain('✦ Add an output schema');
    expect((html.match(/class="sd"/g) ?? []).length).toBe(2);
  });
  it('should escape HTML in model-generated suggestions (no injection into the key-holding panel)', () => {
    const html = suggestionsHtml(['<img src=x onerror="alert(1)">']);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });
  it('should return an empty string for no suggestions', () => {
    expect(suggestionsHtml([])).toBe('');
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

  it('should put the full rationale inside the expandable detail, not only in title=', () => {
    const results: CaseResult[] = [
      { caseId: 'case-1', output: 'resp', score: 4, passed: false, rationale: 'missed the required JSON schema', timing },
    ];
    const cases = [
      { id: 'case-1', category: 'typical' as const, input: 'give me JSON', pinned: false },
    ];
    const html = resultsTableHtml(results, 6, cases);
    // The rationale must survive even with title= stripped — it lives in .mdetail.
    expect(html).toContain('mdetail');
    const withoutTitles = html.replace(/title="[^"]*"/g, '');
    expect(withoutTitles).toContain('missed the required JSON schema');
  });

  it('should expose a non-color aria-label on the score cell conveying value and pass/fail', () => {
    const results: CaseResult[] = [
      { caseId: 'p', output: '', score: 8.5, passed: true, rationale: 'ok', timing },
      { caseId: 'f', output: '', score: 3.2, passed: false, rationale: 'bad', timing },
    ];
    const html = resultsTableHtml(results, 6);
    expect(html).toContain('aria-label="score 8.5, passed"');
    expect(html).toContain('aria-label="score 3.2, failed"');
    // Glyph cue still present in the P/F column.
    expect(html).toContain('pf p');
    expect(html).toContain('pf f');
  });

  it('should render three distinct score-cell bands so mid scores are not collapsed into ok', () => {
    const results: CaseResult[] = [
      { caseId: 'hi', output: '', score: 8.5, passed: true, rationale: 'ok', timing }, // hi band
      { caseId: 'mid', output: '', score: 6.2, passed: true, rationale: 'ok', timing }, // mid band, still passing
      { caseId: 'lo', output: '', score: 3.0, passed: false, rationale: 'bad', timing }, // lo band
    ];
    const html = resultsTableHtml(results, 6);
    expect(html).toContain('class="cell ok"'); // 8.5 → hi
    expect(html).toContain('class="cell mid"'); // 6.2 → mid (distinct, was previously 'ok')
    expect(html).toContain('class="cell lo"'); // 3.0 → lo
    // The mid band is driven by band(score), independent of pass/fail.
    expect(html).toContain('aria-label="score 6.2, passed"');
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

  it('should render the model chip when a version recorded its target', () => {
    const html = versionsTimelineHtml([
      { label: 'v1', note: 'baseline', overall: 7, passLabel: '9/12', avgSeconds: 1.6, delta: null, current: false, model: 'gpt-5.5' },
    ]);
    expect(html).toContain('vmodel');
    expect(html).toContain('gpt-5.5');
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
  const sample = { discrimination: { gap: 2.3, rating: 'good' }, consistency: { stdDev: 0.4, rating: 'good' } };

  it('should render discrimination and consistency numbers', () => {
    const html = rubricHealthHtml(sample);
    expect(html).toContain('good (2.3)'); // discrimination rating + gap
    expect(html).toContain('σ0.4 (good)'); // consistency sigma + rating
  });

  it('should lead with an always-visible plain-language verdict (the rating word)', () => {
    const html = rubricHealthHtml(sample);
    const summary = html.slice(0, html.indexOf('<details'));
    expect(summary).toContain('Rubric health');
    expect(summary).toContain('good'); // rating word visible without expanding
  });

  it('should demote the numeric stats into an Advanced disclosure', () => {
    const html = rubricHealthHtml(sample);
    expect(html).toContain('<details class="adv"><summary>Rubric health detail</summary>');
    // The stats live inside the disclosure, not before it.
    const detailIdx = html.indexOf('<details');
    expect(html.indexOf('σ0.4')).toBeGreaterThan(detailIdx);
    expect(html.indexOf('(2.3)')).toBeGreaterThan(detailIdx);
  });

  it('should define the coined terms inline with a glossary title', () => {
    const html = rubricHealthHtml(sample);
    expect(html).toContain('<span class="term" title="How well your scoring rubric separates strong from weak answers." tabindex="0" role="note" aria-label="How well your scoring rubric separates strong from weak answers.">Rubric health</span>');
    expect(html).toContain('title="Whether the rubric gives clearly different scores to strong vs weak outputs. Higher gap = better separation."');
    expect(html).toContain('title="How stable scores are when the same output is judged repeatedly (lower variation = more consistent)."');
  });

  it('should make each glossary term keyboard-focusable and announce its definition to AT', () => {
    const html = rubricHealthHtml(sample);
    // Three terms: Rubric health, Discrimination, Consistency.
    const focusable = html.match(/class="term" title="[^"]*" tabindex="0" role="note" aria-label="[^"]*"/g) ?? [];
    expect(focusable.length).toBe(3);
    // The definition reaches AT via aria-label, not only the (hover-only) title.
    expect(html).toContain('aria-label="How well your scoring rubric separates strong from weak answers."');
    expect(html).toContain('aria-label="Whether the rubric gives clearly different scores to strong vs weak outputs. Higher gap = better separation."');
    expect(html).toContain('aria-label="How stable scores are when the same output is judged repeatedly (lower variation = more consistent)."');
  });
});

describe('axisHeaderHtml', () => {
  it('should wrap the litmus-axis label in a glossary term with a plain definition', () => {
    const html = axisHeaderHtml();
    expect(html).toContain('class="term"');
    expect(html).toContain('By dimension');
    expect(html).toContain('title="What changed between two versions, broken down by quality dimension."');
  });

  it('should make the term keyboard-focusable and announce its definition to AT', () => {
    const html = axisHeaderHtml();
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="note"');
    // Definition exposed to AT (not only the hover-only title).
    expect(html).toContain('aria-label="What changed between two versions, broken down by quality dimension."');
  });

  it('should escape a custom label', () => {
    expect(axisHeaderHtml('<x>')).toContain('&lt;x&gt;');
  });
});

describe('speedStripHtml', () => {
  it('should convert ms to seconds', () => {
    expect(speedStripHtml({ ttfbMs: 600, avgResponseMs: 1600, tokensPerSec: 94 })).toContain('0.6s');
  });
});

describe('builderLogHtml', () => {
  const turns: BuilderTurnVM[] = [
    { who: 'litmus', text: 'What format do you need?', suggestions: ['JSON', 'Prose'] },
    { who: 'you', text: 'JSON with <category>' },
  ];

  it('should tag each bubble by who said it', () => {
    const out = builderLogHtml(turns);
    expect(out).toContain('class="bub lit"');
    expect(out).toContain('class="bub you"');
  });

  it('should render suggestion chips carrying their fill text', () => {
    const out = builderLogHtml(turns);
    expect(out).toContain('data-fill="JSON"');
    expect(out).toContain('data-fill="Prose"');
  });

  it('should escape user text to prevent HTML injection', () => {
    const out = builderLogHtml([{ who: 'you', text: '<img src=x onerror=alert(1)>' }]);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('should omit the suggestion row when there are none', () => {
    expect(builderLogHtml([{ who: 'litmus', text: 'hi' }])).not.toContain('suggrow');
  });
});
