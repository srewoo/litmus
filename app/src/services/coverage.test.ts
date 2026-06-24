import { describe, it, expect } from 'vitest';
import { buildCoverageMessages, parseCoverage, analyzeCoverage, coverageGaps } from './coverage';
import type { Provider } from '../providers/types';

const valid = JSON.stringify({
  coverage: [
    { instruction: 'Classify into a category', dimension: 'instruction_adherence' },
    { instruction: 'Never reveal chain-of-thought', dimension: null },
  ],
});

describe('buildCoverageMessages', () => {
  it('should list the dimensions to map against', () => {
    const sys = buildCoverageMessages('You are a bot.', ['relevance', 'format'])[0]?.content ?? '';
    expect(sys).toContain('relevance, format');
    expect(sys).toContain('NOT TESTED');
  });
});

describe('parseCoverage', () => {
  it('should parse rows with a nullable dimension', () => {
    const rows = parseCoverage(valid);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.dimension).toBeNull();
  });
});

describe('coverageGaps', () => {
  it('should return only NOT-TESTED instructions', () => {
    expect(coverageGaps(parseCoverage(valid))).toHaveLength(1);
  });
});

describe('analyzeCoverage', () => {
  it('should call the model and return the matrix', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: valid, timing: { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 } };
      },
    };
    const rows = await analyzeCoverage('SYS', ['relevance'], { provider, apiKey: 'sk', model: 'm' });
    expect(rows).toHaveLength(2);
  });
});
