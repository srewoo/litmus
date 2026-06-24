import { describe, it, expect } from 'vitest';
import { collectFailures, buildFixMessages, parseFixes, suggestFixes } from './fixes';
import type { Provider } from '../providers/types';
import type { CaseResult, EvalCase, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };

const cases: EvalCase[] = [
  { id: 'c1', category: 'typical', input: 'good', pinned: false },
  { id: 'c2', category: 'edge', input: 'tricky', pinned: false },
];

const results: CaseResult[] = [
  { caseId: 'c1', output: 'o', score: 9, passed: true, rationale: 'great', timing },
  { caseId: 'c2', output: 'o', score: 3, passed: false, rationale: 'missed the edge', timing },
];

describe('collectFailures', () => {
  it('should pair failing results with their case input', () => {
    const failures = collectFailures(cases, results);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ caseId: 'c2', input: 'tricky', rationale: 'missed the edge' });
  });
});

describe('buildFixMessages', () => {
  it('should embed the prompt and each failure', () => {
    const msgs = buildFixMessages('SYS', collectFailures(cases, results));
    expect(msgs[1]?.content).toContain('SYS');
    expect(msgs[1]?.content).toContain('c2');
  });
});

describe('parseFixes', () => {
  it('should parse a ranked list of fixes', () => {
    const fixes = parseFixes('{"fixes":[{"title":"Add fallback","edit":"...","caseRef":"c2"}]}');
    expect(fixes[0]?.title).toBe('Add fallback');
  });
  it('should reject a malformed fix', () => {
    expect(() => parseFixes('{"fixes":[{"title":"x"}]}')).toThrow();
  });
});

describe('suggestFixes', () => {
  it('should short-circuit to [] when nothing failed', async () => {
    const provider: Provider = { id: 'openai', async chat() { throw new Error('should not be called'); } };
    const allPass = results.map((r) => ({ ...r, passed: true, score: 9 }));
    expect(await suggestFixes('SYS', cases, allPass, { provider, apiKey: 'sk', model: 'm' })).toEqual([]);
  });

  it('should request fixes when there are failures', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return {
          text: '{"fixes":[{"title":"Handle the edge","edit":"add a rule","caseRef":"c2"}]}',
          timing,
        };
      },
    };
    const fixes = await suggestFixes('SYS', cases, results, { provider, apiKey: 'sk', model: 'm' });
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.caseRef).toBe('c2');
  });
});
