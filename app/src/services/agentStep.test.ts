import { describe, it, expect } from 'vitest';
import { providerStep } from './agentStep';
import type { AgentTurn } from './agentRun';
import type { Provider, ChatRequest } from '../providers/types';
import type { Timing } from '../shared/types';

const timing: Timing = { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 };

describe('providerStep', () => {
  it('maps agent turns to chat messages, forwards tools, and returns text + toolCalls', async () => {
    let seen: ChatRequest | null = null;
    const provider: Provider = {
      id: 'openai',
      async chat(req) {
        seen = req;
        return { text: 'ok', timing, toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] };
      },
    };
    const turns: AgentTurn[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'checking', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] },
      { role: 'tool', toolName: 'get_weather', content: '{"tempC":18}' },
    ];
    const step = providerStep({
      provider,
      apiKey: 'sk',
      model: 'm',
      tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
    });
    const out = await step(turns);
    expect(out).toEqual({ text: 'ok', toolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }], timing });
    expect(seen!.tools?.[0]?.name).toBe('get_weather');
    expect(seen!.messages[2]).toMatchObject({ role: 'assistant', toolCalls: [{ name: 'get_weather' }] });
    expect(seen!.messages[3]).toMatchObject({ role: 'tool', toolName: 'get_weather' });
  });

  it('returns an empty toolCalls array when the model just answers', async () => {
    const provider: Provider = { id: 'openai', async chat() { return { text: 'done', timing }; } };
    const step = providerStep({ provider, apiKey: 'sk', model: 'm', tools: [] });
    expect(await step([{ role: 'user', content: 'hi' }])).toEqual({ text: 'done', toolCalls: [], timing });
  });
});
