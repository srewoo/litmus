import { describe, it, expect } from 'vitest';
import { buildAnalysisMessages, parseAnalysis, analyzePrompt } from './analysis';
import type { Provider, ChatRequest, ChatCallOptions } from '../providers/types';
import type { TargetModel } from '../shared/types';

const target: TargetModel = { provider: 'openai', model: 'gpt-5.1' };

const validJson = JSON.stringify({
  facets: [
    { facet: 'language', score: 8.5, finding: 'clear' },
    { facet: 'format', score: 4.8, finding: 'no schema' },
  ],
  suggestions: ['Pin the JSON schema.'],
});

describe('buildAnalysisMessages', () => {
  it('should name the target model and carry the prompt as the user turn', () => {
    const msgs = buildAnalysisMessages('You are a triage bot.', target);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.content).toContain('openai/gpt-5.1');
    expect(msgs[1]).toEqual({ role: 'user', content: 'You are a triage bot.' });
  });
});

describe('parseAnalysis', () => {
  it('should parse valid JSON into a typed analysis', () => {
    const a = parseAnalysis(validJson);
    expect(a.facets).toHaveLength(2);
    expect(a.suggestions[0]).toContain('schema');
  });
  it('should tolerate accidental code fences', () => {
    expect(parseAnalysis('```json\n' + validJson + '\n```').facets).toHaveLength(2);
  });
  it('should reject an out-of-range score', () => {
    const bad = JSON.stringify({ facets: [{ facet: 'tone', score: 99, finding: 'x' }], suggestions: [] });
    expect(() => parseAnalysis(bad)).toThrow();
  });
  it('should reject non-JSON output', () => {
    expect(() => parseAnalysis('the prompt looks fine to me')).toThrow();
  });
});

describe('analyzePrompt', () => {
  it('should call the analyzer model and return the parsed analysis', async () => {
    let seen: { request: ChatRequest; options: ChatCallOptions } | null = null;
    const provider: Provider = {
      id: 'openai',
      async chat(request, options) {
        seen = { request, options };
        return { text: validJson, timing: { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 } };
      },
    };

    const analysis = await analyzePrompt('You are a triage bot.', target, {
      provider,
      apiKey: 'sk-test',
      analyzerModel: 'gpt-5.1-mini',
    });

    expect(analysis.facets).toHaveLength(2);
    expect(seen!.request.model).toBe('gpt-5.1-mini');
    expect(seen!.options.apiKey).toBe('sk-test');
  });
});
