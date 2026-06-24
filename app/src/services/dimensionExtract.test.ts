import { describe, it, expect } from 'vitest';
import { buildDimensionMessages, parseDimensions, extractDimensions } from './dimensionExtract';
import type { Provider } from '../providers/types';

const valid = JSON.stringify({
  dimensions: [
    { name: 'answer_relevance', description: 'Does the answer address the query?' },
    { name: 'format_compliance', description: 'Is the JSON schema followed?' },
  ],
});

describe('buildDimensionMessages', () => {
  it('should ask to scale dimensions to complexity and use the taxonomy', () => {
    const sys = buildDimensionMessages('You are a judge.')[0]?.content ?? '';
    expect(sys).toMatch(/2.?3 dimensions/);
    expect(sys).toContain('instruction_adherence');
  });
});

describe('parseDimensions', () => {
  it('should parse a dimension list', () => {
    const dims = parseDimensions(valid);
    expect(dims).toHaveLength(2);
    expect(dims[0]?.name).toBe('answer_relevance');
  });
  it('should reject an empty list', () => {
    expect(() => parseDimensions(JSON.stringify({ dimensions: [] }))).toThrow();
  });
});

describe('extractDimensions', () => {
  it('should call the model and return dimensions', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: valid, timing: { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 } };
      },
    };
    const dims = await extractDimensions('SYS', { provider, apiKey: 'sk', model: 'm' });
    expect(dims.map((d) => d.name)).toEqual(['answer_relevance', 'format_compliance']);
  });
});
