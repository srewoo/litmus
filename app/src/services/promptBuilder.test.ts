import { describe, it, expect } from 'vitest';
import { buildBuilderMessages, parseBuilderTurn, builderTurn, BUILDER_SYSTEM } from './promptBuilder';
import type { Provider, ChatRequest, ChatCallOptions, ChatMessage } from '../providers/types';

const question = JSON.stringify({
  kind: 'question',
  message: 'Who is the audience, and what output format do you need?',
  suggestions: ['Developers, JSON', 'End users, prose'],
});

const finalPrompt = JSON.stringify({
  kind: 'prompt',
  systemPrompt: 'You are a support-triage assistant. Return JSON with category and urgency.',
  summary: 'Built a triage assistant; assumed a JSON output contract.',
});

describe('buildBuilderMessages', () => {
  it('should lead with the architect system prompt and carry the conversation', () => {
    const convo: ChatMessage[] = [{ role: 'user', content: 'A ticket triager.' }];
    const msgs = buildBuilderMessages(convo);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toBe(BUILDER_SYSTEM);
    expect(msgs[1]).toEqual({ role: 'user', content: 'A ticket triager.' });
    expect(msgs).toHaveLength(2);
  });

  it('should append a force-generate instruction only when asked', () => {
    const convo: ChatMessage[] = [{ role: 'user', content: 'A ticket triager.' }];
    const forced = buildBuilderMessages(convo, true);
    expect(forced).toHaveLength(3);
    expect(forced[2]?.role).toBe('user');
    expect(forced[2]?.content.toLowerCase()).toContain('generate the final system prompt');
  });
});

describe('parseBuilderTurn', () => {
  it('should parse a question turn', () => {
    const turn = parseBuilderTurn(question);
    expect(turn.kind).toBe('question');
    if (turn.kind === 'question') expect(turn.suggestions).toHaveLength(2);
  });

  it('should parse a final prompt turn', () => {
    const turn = parseBuilderTurn(finalPrompt);
    expect(turn.kind).toBe('prompt');
    if (turn.kind === 'prompt') expect(turn.systemPrompt).toContain('triage');
  });

  it('should default missing suggestions to an empty array', () => {
    const turn = parseBuilderTurn('{"kind":"question","message":"What is the goal?"}');
    if (turn.kind === 'question') expect(turn.suggestions).toEqual([]);
  });

  it('should tolerate accidental code fences', () => {
    expect(parseBuilderTurn('```json\n' + question + '\n```').kind).toBe('question');
  });

  it('should reject an unknown kind', () => {
    expect(() => parseBuilderTurn('{"kind":"chat","message":"hi"}')).toThrow();
  });

  it('should reject a prompt turn with an empty systemPrompt', () => {
    expect(() => parseBuilderTurn('{"kind":"prompt","systemPrompt":"","summary":"x"}')).toThrow();
  });

  it('should reject non-JSON output', () => {
    expect(() => parseBuilderTurn('let me think about that')).toThrow();
  });
});

describe('builderTurn', () => {
  it('should call the model and return the parsed turn, with temperature on a normal turn', async () => {
    let seen: { request: ChatRequest; options: ChatCallOptions } | null = null;
    const provider: Provider = {
      id: 'anthropic',
      async chat(request, options) {
        seen = { request, options };
        return { text: question, timing: { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 } };
      },
    };

    const turn = await builderTurn([{ role: 'user', content: 'A triager.' }], {
      provider,
      apiKey: 'sk-test',
      model: 'claude-x',
    });

    expect(turn.kind).toBe('question');
    expect(seen!.request.model).toBe('claude-x');
    expect(seen!.request.temperature).toBeGreaterThan(0);
    expect(seen!.options.apiKey).toBe('sk-test');
  });

  it('should generate deterministically (temperature 0) when forced, with the force instruction sent', async () => {
    let seen: ChatRequest | null = null;
    const provider: Provider = {
      id: 'anthropic',
      async chat(request) {
        seen = request;
        return { text: finalPrompt, timing: { ttfbMs: 1, totalMs: 1, tokens: 1, tokensPerSec: 1 } };
      },
    };

    const turn = await builderTurn([{ role: 'user', content: 'A triager.' }], { provider, apiKey: 'k', model: 'm' }, true);

    expect(turn.kind).toBe('prompt');
    expect(seen!.temperature).toBe(0);
    expect(seen!.messages.at(-1)?.content.toLowerCase()).toContain('generate the final system prompt');
  });
});
