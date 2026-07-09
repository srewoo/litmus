import { describe, it, expect } from 'vitest';
import { mediaCapability, mediaModelMismatch } from './mediaCapability';

describe('mediaCapability', () => {
  it('should classify known image families', () => {
    for (const m of ['gpt-image-1', 'dall-e-3', 'dalle-3', 'imagen-3.0', 'stable-diffusion-xl', 'flux-pro', 'seedream-3', 'nano-banana']) {
      expect(mediaCapability('openai', m)).toBe('image');
    }
  });

  it('should classify known video families', () => {
    for (const m of ['sora-2', 'veo-3', 'runway-gen3', 'kling-1.5', 'pika-2', 'luma-ray', 'seedance-1']) {
      expect(mediaCapability('google', m)).toBe('video');
    }
  });

  it('should classify known voice/TTS families but NOT ASR (whisper)', () => {
    expect(mediaCapability('openai', 'gpt-4o-mini-tts')).toBe('voice');
    expect(mediaCapability('openai', 'eleven-multilingual-v2')).toBe('voice');
    // whisper/transcribe are input-side ASR, not generation → unknown, not voice.
    expect(mediaCapability('openai', 'whisper-1')).toBe('unknown');
  });

  it('should FAIL-OPEN to unknown for unrecognized / chat / custom ids', () => {
    expect(mediaCapability('openai', 'gpt-5.1')).toBe('unknown');
    expect(mediaCapability('anthropic', 'claude-sonnet-4.6')).toBe('unknown');
    expect(mediaCapability('openai', 'ft:some-future-model:org')).toBe('unknown');
  });
});

describe('mediaModelMismatch (friendly pre-check)', () => {
  it('should flag a known-wrong pairing', () => {
    expect(mediaModelMismatch('openai', 'gpt-image-1', 'video')).toBe(true);
    expect(mediaModelMismatch('openai', 'gpt-image-1', 'image')).toBe(false);
  });

  it('should NEVER flag an unknown-capability model (fail-open)', () => {
    expect(mediaModelMismatch('openai', 'gpt-5.1', 'image')).toBe(false);
    expect(mediaModelMismatch('openai', 'gpt-5.1', 'document')).toBe(false); // chat model for docs is allowed
    expect(mediaModelMismatch('anthropic', 'some-new-id', 'voice')).toBe(false);
  });
});
