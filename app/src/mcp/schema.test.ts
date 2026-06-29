import { describe, it, expect } from 'vitest';
import {
  toCallResult,
  toHandshake,
  toPrompts,
  toResources,
  toToolDescriptors,
} from './schema';

describe('toHandshake', () => {
  it('maps capability presence to booleans and carries the session id', () => {
    const h = toHandshake(
      {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'demo', version: '1.2.3' },
      },
      'sess-1',
    );
    expect(h.capabilities).toEqual({ tools: true, resources: false, prompts: true });
    expect(h.serverInfo).toEqual({ name: 'demo', version: '1.2.3' });
    expect(h.sessionId).toBe('sess-1');
  });
  it('defaults serverInfo when the server omits it', () => {
    const h = toHandshake({ protocolVersion: '2025-06-18' });
    expect(h.serverInfo.name).toBe('unknown');
    expect(h.capabilities.tools).toBe(false);
  });
  it('throws on a malformed handshake (no protocolVersion)', () => {
    expect(() => toHandshake({ capabilities: {} })).toThrow();
  });
});

describe('toToolDescriptors', () => {
  it('maps tools and defaults a missing inputSchema to an open object', () => {
    const tools = toToolDescriptors({
      tools: [
        { name: 'get_weather', description: 'd', inputSchema: { type: 'object', required: ['city'] } },
        { name: 'now' },
      ],
    });
    expect(tools[0]).toEqual({
      name: 'get_weather',
      description: 'd',
      inputSchema: { type: 'object', required: ['city'] },
    });
    expect(tools[1]).toEqual({ name: 'now', inputSchema: { type: 'object' } });
  });
  it('rejects a tool with no name', () => {
    expect(() => toToolDescriptors({ tools: [{ description: 'x' }] })).toThrow();
  });
});

describe('toResources / toPrompts', () => {
  it('maps resources, keeping only present optional fields', () => {
    expect(toResources({ resources: [{ uri: 'file://a', name: 'A' }] })).toEqual([{ uri: 'file://a', name: 'A' }]);
  });
  it('maps prompts with arguments', () => {
    const p = toPrompts({ prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }] });
    expect(p[0]?.arguments?.[0]).toEqual({ name: 'who', required: true });
  });
  it('defaults to empty arrays', () => {
    expect(toResources({})).toEqual([]);
    expect(toPrompts({})).toEqual([]);
  });
});

describe('toCallResult', () => {
  it('concatenates text blocks and reads isError', () => {
    const r = toCallResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false });
    expect(r).toEqual({ isError: false, text: 'a\nb', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] });
  });
  it('treats a server error result as isError with its text', () => {
    const r = toCallResult({ content: [{ type: 'text', text: 'boom' }], isError: true });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('boom');
  });
  it('ignores non-text content for the text field', () => {
    expect(toCallResult({ content: [{ type: 'image', data: 'x' }] }).text).toBe('');
  });
});
