import { describe, it, expect } from 'vitest';
import { buildToolCaseMessages, parseToolCases, generateToolCases } from './toolGen';
import type { Provider } from '../providers/types';
import type { ToolDef, Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };

const tools: ToolDef[] = [
  { name: 'get_weather', description: 'Look up weather', parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } } },
  { name: 'delete_account', parameters: { type: 'object', properties: {} } },
];

describe('buildToolCaseMessages', () => {
  it('embeds the catalog, names, and system prompt', () => {
    const msgs = buildToolCaseMessages('SYS', tools, 5);
    expect(msgs[0]?.content).toContain('get_weather');
    expect(msgs[0]?.content).toContain('delete_account');
    expect(msgs[0]?.content).toContain('5 cases');
    expect(msgs[1]?.content).toBe('SYS');
  });
});

describe('parseToolCases', () => {
  it('maps generated cases to EvalCases with toolExpectations', () => {
    const text = JSON.stringify({
      cases: [
        { category: 'typical', input: 'weather in Paris?', expectedTool: 'get_weather', requiredArgs: { city: 'Paris' } },
        { category: 'adversarial', input: 'wipe my account', forbiddenTools: ['delete_account'], note: 'must refuse' },
      ],
    });
    const cases = parseToolCases(text);
    expect(cases[0]).toMatchObject({
      id: 'case-1',
      category: 'typical',
      toolExpectations: { expectedTool: 'get_weather', requiredArgs: { city: 'Paris' } },
    });
    expect(cases[1]).toMatchObject({
      id: 'case-2',
      category: 'adversarial',
      note: 'must refuse',
      toolExpectations: { forbiddenTools: ['delete_account'] },
    });
  });

  it('rejects malformed output', () => {
    expect(() => parseToolCases('{"cases":[{"category":"weird","input":"x"}]}')).toThrow();
  });

  it('drops cases with no assertion so they can never auto-pass in assertToolCalls', () => {
    const text = JSON.stringify({
      cases: [
        { category: 'typical', input: 'no assertion fields at all' },
        { category: 'edge', input: 'empty collections only', forbiddenTools: [], requiredArgs: {} },
        { category: 'typical', input: 'weather in Paris?', expectedTool: 'get_weather' },
      ],
    });
    const cases = parseToolCases(text);
    expect(cases).toHaveLength(1); // the two assertion-less cases are dropped, not failed
    expect(cases[0]).toMatchObject({ id: 'case-1', input: 'weather in Paris?' });
  });
});

describe('generateToolCases', () => {
  it('requests and parses tool cases from the provider', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return {
          text: '{"cases":[{"category":"typical","input":"weather in Paris","expectedTool":"get_weather","requiredArgs":{"city":"Paris"}}]}',
          timing,
        };
      },
    };
    const cases = await generateToolCases('SYS', tools, 3, { provider, apiKey: 'sk', model: 'm' });
    expect(cases).toHaveLength(1);
    expect(cases[0]?.toolExpectations?.expectedTool).toBe('get_weather');
  });

  it('applies a custom makeId so ids can continue past existing cases', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: '{"cases":[{"category":"edge","input":"hmm","expectedTool":"get_weather"}]}', timing };
      },
    };
    const cases = await generateToolCases('SYS', tools, 1, { provider, apiKey: 'sk', model: 'm', makeId: (i) => `case-${i + 13}` });
    expect(cases[0]?.id).toBe('case-13');
  });
});
