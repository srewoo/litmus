import { describe, it, expect } from 'vitest';
import { generateEvalSuite, combineRubrics } from './evalSuite';
import type { Provider, ChatRequest } from '../providers/types';

const timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };

// Provider returns dimensions JSON for the extract instruction, else rubric text.
const provider: Provider = {
  id: 'openai',
  async chat(req: ChatRequest) {
    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
    if (sys.includes('evaluation architect')) {
      return {
        text: JSON.stringify({
          dimensions: [
            { name: 'relevance', description: 'on topic' },
            { name: 'format', description: 'schema ok' },
          ],
        }),
        timing,
      };
    }
    return { text: `RUBRIC for one dimension`, timing };
  },
};

describe('generateEvalSuite', () => {
  it('should extract dimensions and generate a rubric for each, reporting progress', async () => {
    const progress: string[] = [];
    const suite = await generateEvalSuite('SYS', { provider, apiKey: 'sk', model: 'm' }, undefined, (d) => progress.push(d));
    expect(suite.dimensions.map((d) => d.name)).toEqual(['relevance', 'format']);
    expect(Object.keys(suite.rubrics)).toEqual(['relevance', 'format']);
    expect(suite.rubrics.relevance).toContain('RUBRIC');
    expect(progress).toEqual(['relevance', 'format']);
  });
});

describe('generateEvalSuite with duplicate dimension names', () => {
  it('dedupes duplicate dimension names so rubric count matches dimension count', async () => {
    const dupProvider: Provider = {
      id: 'openai',
      async chat(req: ChatRequest) {
        const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
        if (sys.includes('evaluation architect')) {
          return {
            text: JSON.stringify({
              dimensions: [
                { name: 'relevance', description: 'first' },
                { name: 'relevance', description: 'duplicate' },
                { name: 'format', description: 'schema ok' },
              ],
            }),
            timing,
          };
        }
        return { text: 'RUBRIC', timing };
      },
    };
    const progress: string[] = [];
    const suite = await generateEvalSuite('SYS', { provider: dupProvider, apiKey: 'sk', model: 'm' }, undefined, (d) =>
      progress.push(d),
    );
    expect(suite.dimensions.map((d) => d.name)).toEqual(['relevance', 'format']); // dup dropped
    expect(Object.keys(suite.rubrics)).toEqual(['relevance', 'format']);
    expect(suite.dimensions).toHaveLength(Object.keys(suite.rubrics).length); // count matches
    expect(progress).toEqual(['relevance', 'format']); // progress reports the real count
  });
});

describe('combineRubrics', () => {
  it('should label and join rubrics by dimension', () => {
    const combined = combineRubrics({ relevance: 'R1', format: 'R2' });
    expect(combined).toContain('### DIMENSION: relevance');
    expect(combined).toContain('### DIMENSION: format');
    expect(combined).toContain('R1');
  });
  it('should return empty string for no rubrics', () => {
    expect(combineRubrics({})).toBe('');
  });
});
