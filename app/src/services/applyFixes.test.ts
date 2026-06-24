import { describe, it, expect } from 'vitest';
import { buildApplyMessages, applyFixes } from './applyFixes';
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

  it('should fall back to the original prompt if the model returns empty text', async () => {
    const provider: Provider = {
      id: 'openai',
      async chat() {
        return { text: '   ', timing };
      },
    };
    expect(await applyFixes('SYS', fixes, { provider, apiKey: 'sk', model: 'm' })).toBe('SYS');
  });
});
