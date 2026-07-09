import { describe, it, expect } from 'vitest';
import { checkVoice } from './voice';
import type { VoiceSignals } from '../../shared/media';

const base: VoiceSignals = {
  decoded: true,
  durationSec: 3.2,
  sampleRate: 24000,
  channels: 1,
  rms: 0.12,
  clipping: false,
  transcript: 'hello there general kenobi',
  wer: 0.0,
  language: 'en-US',
  voiceSimilarity: 0.9,
};

describe('checkVoice', () => {
  it('should pass with a clean ASR round-trip, language, and voice match', () => {
    const r = checkVoice(base, { text: 'hello there general kenobi', language: 'en', voiceId: 'nova' });
    expect(r.passed).toBe(true);
    expect(r.dimensions.find((d) => d.dimension === 'transcription_accuracy')?.score).toBe(10);
    expect(r.dimensions.find((d) => d.dimension === 'voice_similarity')?.score).toBe(9);
  });

  it('should fail on WER above threshold (the load-bearing TTS check)', () => {
    const r = checkVoice({ ...base, wer: 0.4 }, { text: 'hello there general kenobi' });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/word-error-rate 0.4 exceeds/);
    expect(r.dimensions.find((d) => d.dimension === 'transcription_accuracy')?.score).toBe(6);
  });

  it('should gate on silence, clipping, sample rate, and channels', () => {
    expect(checkVoice({ ...base, rms: 0 }, {}).reasons.join()).toMatch(/silent/);
    expect(checkVoice({ ...base, clipping: true }, {}).reasons.join()).toMatch(/clips/);
    expect(checkVoice({ ...base, sampleRate: 0 }, {}).reasons.join()).toMatch(/sample rate/);
    expect(checkVoice({ ...base, channels: 0 }, {}).reasons.join()).toMatch(/no channels/);
  });

  it('should gate on duration bounds', () => {
    expect(checkVoice(base, { minDurationSec: 5 }).reasons.join()).toMatch(/below min/);
    expect(checkVoice(base, { maxDurationSec: 2 }).reasons.join()).toMatch(/above max/);
  });

  it('should fail a language mismatch', () => {
    const r = checkVoice({ ...base, language: 'fr-FR' }, { language: 'en' });
    expect(r.passed).toBe(false);
    expect(r.dimensions.find((d) => d.dimension === 'language_match')?.score).toBe(0);
  });

  it('should fail low voice similarity', () => {
    expect(checkVoice({ ...base, voiceSimilarity: 0.4 }, { voiceId: 'nova' }).reasons.join()).toMatch(/voice similarity/);
  });

  it('should fail undecodable audio', () => {
    expect(checkVoice({ ...base, decoded: false }, {}).reasons.join()).toMatch(/did not decode/);
  });

  it('should skip the WER check when no text or no transcript is available', () => {
    const noText = checkVoice(base, { language: 'en' });
    expect(noText.dimensions.some((d) => d.dimension === 'transcription_accuracy')).toBe(false);
  });
});
