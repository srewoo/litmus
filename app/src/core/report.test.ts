import { describe, it, expect } from 'vitest';
import { buildJsonReport, buildMarkdownReport } from './report';
import type { ReportEntry } from './report';

const entries: ReportEntry[] = [
  {
    label: 'v1',
    note: 'baseline',
    prompt: 'You are a bot.',
    model: 'gpt-5.5',
    run: { overall: 6.8, passCount: 9, failCount: 3, total: 12, speed: { ttfbMs: 600, avgResponseMs: 1600, tokensPerSec: 94 } },
  },
  { label: 'v2', note: 'fixed schema', prompt: 'You are a better bot.', run: null },
];

describe('buildMarkdownReport', () => {
  it('should include each version, score, speed, note, and prompt', () => {
    const md = buildMarkdownReport(entries);
    expect(md).toContain('## v1');
    expect(md).toContain('6.8/10');
    expect(md).toContain('9/12 passed');
    expect(md).toContain('TTFB 0.6s');
    expect(md).toContain('baseline');
    expect(md).toContain('Model: `gpt-5.5`');
    expect(md).toContain('You are a bot.');
    expect(md).toContain('_No run recorded._'); // v2
  });
  it('should handle an empty history', () => {
    expect(buildMarkdownReport([])).toContain('No versions yet');
  });
});

describe('buildJsonReport', () => {
  it('should produce parseable JSON with the versions', () => {
    const parsed = JSON.parse(buildJsonReport(entries)) as { tool: string; versions: ReportEntry[] };
    expect(parsed.tool).toBe('litmus');
    expect(parsed.versions).toHaveLength(2);
    expect(parsed.versions[0]?.label).toBe('v1');
  });
});
