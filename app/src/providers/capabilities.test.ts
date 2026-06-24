import { describe, it, expect } from 'vitest';
import { supportsTemperature, isChatModel } from './capabilities';

describe('supportsTemperature', () => {
  it('should omit temperature for the GPT-5 family and o-series reasoning models', () => {
    expect(supportsTemperature('openai', 'o3')).toBe(false);
    expect(supportsTemperature('openai', 'o4-mini')).toBe(false);
    expect(supportsTemperature('openai', 'gpt-5-mini')).toBe(false);
    expect(supportsTemperature('openai', 'gpt-5.5')).toBe(false);
  });
  it('should send temperature for gpt-4 / gpt-3.5 family models', () => {
    expect(supportsTemperature('openai', 'gpt-4o')).toBe(true);
    expect(supportsTemperature('openai', 'gpt-4.1')).toBe(true);
    expect(supportsTemperature('openai', 'gpt-3.5-turbo')).toBe(true);
  });
  it('should send temperature for non-OpenAI providers', () => {
    expect(supportsTemperature('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(supportsTemperature('google', 'gemini-3.5-pro')).toBe(true);
  });
});

describe('isChatModel', () => {
  it('should drop non-chat OpenAI models', () => {
    expect(isChatModel('openai', 'text-embedding-3-large')).toBe(false);
    expect(isChatModel('openai', 'whisper-1')).toBe(false);
    expect(isChatModel('openai', 'dall-e-3')).toBe(false);
    expect(isChatModel('openai', 'gpt-4o-realtime')).toBe(false);
  });
  it('should keep chat models', () => {
    expect(isChatModel('openai', 'gpt-5.5')).toBe(true);
    expect(isChatModel('openai', 'o3')).toBe(true);
  });
  it('should keep all models for other providers', () => {
    expect(isChatModel('google', 'gemini-3.5-flash')).toBe(true);
  });
});
