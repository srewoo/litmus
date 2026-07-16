import { describe, it, expect } from 'vitest';
import { buildApplyMessages, applyFixes, extractPlaceholders, checkPlaceholders } from './applyFixes';
import type { Fix } from './fixes';
import type { Provider } from '../providers/types';
import type { Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };

const fixes: Fix[] = [
  { title: 'Handle multi-issue input', edit: 'classify each issue separately', caseRef: 'case-12' },
  { title: 'Justify urgency', edit: 'add a reason field per urgency level' },
];

describe('buildApplyMessages', () => {
  it('should embed the prompt and every fix', () => {
    const msgs = buildApplyMessages('SYS PROMPT', fixes);
    expect(msgs[1]?.content).toContain('SYS PROMPT');
    expect(msgs[1]?.content).toContain('Handle multi-issue input');
    expect(msgs[1]?.content).toContain('Justify urgency');
    expect(msgs[1]?.content).toContain('case-12');
  });
});

describe('applyFixes', () => {
  it('should return the prompt unchanged and make no call when there are no fixes', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        throw new Error('should not be called');
      },
    };
    expect(await applyFixes('SYS', [], { provider, apiKey: 'sk', model: 'm' })).toBe('SYS');
  });

  it('should return the revised prompt from the model', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: 'REVISED PROMPT', timing };
      },
    };
    expect(await applyFixes('SYS', fixes, { provider, apiKey: 'sk', model: 'm' })).toBe('REVISED PROMPT');
  });

  it('should strip accidental code fences', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: '```\nREVISED\n```', timing };
      },
    };
    expect(await applyFixes('SYS', fixes, { provider, apiKey: 'sk', model: 'm' })).toBe('REVISED');
  });

  it('should strip only a fence that wraps the whole prompt, preserving internal code blocks', async () => {
    const revised = 'You are a helper.\nReturn JSON like:\n```json\n{"ok":true}\n```\nNever add prose.';
    const provider: Provider = {
      id: 'openai',
      async chat() {
        // The model wrapped the whole prompt in a fence, but the prompt itself contains a fenced block.
        return { text: '```\n' + revised + '\n```', timing };
      },
    };
    const out = await applyFixes('SYS', fixes, { provider, apiKey: 'sk', model: 'm' });
    expect(out).toBe(revised);
    expect(out).toContain('```json'); // internal fence preserved
  });

  it('should leave an unfenced prompt that contains a code block untouched', async () => {
    const revised = 'Do X.\n```ts\nconst a = 1;\n```\nDone.';
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: revised, timing };
      },
    };
    expect(await applyFixes('SYS', fixes, { provider, apiKey: 'sk', model: 'm' })).toBe(revised);
  });

  it('should fall back to the original prompt if the model returns empty text', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: '   ', timing };
      },
    };
    expect(await applyFixes('SYS', fixes, { provider, apiKey: 'sk', model: 'm' })).toBe('SYS');
  });

  it('should throw an error if a placeholder is missing in the revised prompt', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: 'Revised text without placeholder', timing };
      },
    };
    await expect(
      applyFixes('Please translate {{text_to_translate}} now', fixes, { provider, apiKey: 'sk', model: 'm' })
    ).rejects.toThrow('Placeholder validation failed: the revised prompt is missing original variables: {{text_to_translate}}');
  });

  it('should succeed if all placeholders are preserved in the revised prompt', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: 'Revised: {{text_to_translate}}', timing };
      },
    };
    const out = await applyFixes('Please translate {{text_to_translate}} now', fixes, { provider, apiKey: 'sk', model: 'm' });
    expect(out).toBe('Revised: {{text_to_translate}}');
  });
});

describe('placeholder helpers', () => {
  it('should extract and deduplicate placeholders', () => {
    const text = 'Hello {{name}}, you are {{age}} years old. Greetings {{name}}!';
    const extracted = extractPlaceholders(text);
    expect(extracted).toEqual(['{{name}}', '{{age}}']);
  });

  it('should return empty array if no placeholders exist', () => {
    expect(extractPlaceholders('Hello world')).toEqual([]);
  });

  it('should check for missing placeholders correctly', () => {
    const original = 'Prompt with {{a}} and {{b}}';
    const revisedSafe = 'New {{a}} and {{b}}';
    const revisedUnsafe = 'New {{a}} only';
    expect(checkPlaceholders(original, revisedSafe)).toEqual([]);
    expect(checkPlaceholders(original, revisedUnsafe)).toEqual(['{{b}}']);
  });
});

describe('buildApplyMessages formatting and harvesting', () => {
  it('should embed Claude-specific guidelines for Anthropic target', () => {
    const msgs = buildApplyMessages('SYS', fixes, { provider: 'anthropic', model: 'claude-3-opus' });
    expect(msgs[0]?.content).toContain('anthropic/claude-3-opus');
    expect(msgs[0]?.content).toContain('XML tags');
  });

  it('should embed CO-STAR guidelines for Google target', () => {
    const msgs = buildApplyMessages('SYS', fixes, { provider: 'google', model: 'gemini-1.5-pro' });
    expect(msgs[0]?.content).toContain('google/gemini-1.5-pro');
    expect(msgs[0]?.content).toContain('CO-STAR');
  });

  it('should embed OpenAI-specific guidelines for OpenAI target', () => {
    const msgs = buildApplyMessages('SYS', fixes, { provider: 'openai', model: 'gpt-4o' });
    expect(msgs[0]?.content).toContain('openai/gpt-4o');
    expect(msgs[0]?.content).toContain('concise instructions');
  });

  it('should harvest and format successful and failed examples', () => {
    const cases = [
      { id: 'c1', category: 'typical', input: 'input1', pinned: false },
      { id: 'c2', category: 'typical', input: 'input2', pinned: false },
    ] as const;
    const results = [
      { caseId: 'c1', output: 'good output', score: 9.5, passed: true, rationale: 'Excellent', timing },
      { caseId: 'c2', output: 'bad output', score: 3, passed: false, rationale: 'Missing details', timing },
    ];

    const msgs = buildApplyMessages('SYS', fixes, undefined, cases, results, 6);
    expect(msgs[1]?.content).toContain('SUCCESSFUL EXAMPLES');
    expect(msgs[1]?.content).toContain('input1');
    expect(msgs[1]?.content).toContain('good output');

    expect(msgs[1]?.content).toContain('FAILED EXAMPLES');
    expect(msgs[1]?.content).toContain('input2');
    expect(msgs[1]?.content).toContain('bad output');
    expect(msgs[1]?.content).toContain('Missing details');
  });

  it('should ignore tool, scenario, and media cases during harvesting', () => {
    const cases = [
      { id: 'c1', category: 'typical', input: 'input1', pinned: false, toolExpectations: {} },
      { id: 'c2', category: 'typical', input: 'input2', pinned: false, scenario: { goal: 'run' } },
      { id: 'c3', category: 'typical', input: 'input3', pinned: false, media: { kind: 'image' } },
    ] as any;
    const results = [
      { caseId: 'c1', output: 'out1', score: 10, passed: true, rationale: '', timing },
      { caseId: 'c2', output: 'out2', score: 10, passed: true, rationale: '', timing },
      { caseId: 'c3', output: 'out3', score: 10, passed: true, rationale: '', timing },
    ];

    const msgs = buildApplyMessages('SYS', fixes, undefined, cases, results, 6);
    expect(msgs[1]?.content).not.toContain('SUCCESSFUL EXAMPLES');
  });
});
