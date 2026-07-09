import { describe, it, expect } from 'vitest';
import { checkMedia, describeCheck } from './index';
import type { MediaExpectation, MediaSignals } from '../../shared/media';

describe('checkMedia dispatcher', () => {
  it('should route each kind to its pack', () => {
    const img: MediaSignals = { kind: 'image', decoded: true, width: 512, height: 512, format: 'png', count: 1, safetyBlocked: false, labels: [], ocrText: '' };
    expect(checkMedia(img, { kind: 'image', width: 512 }).passed).toBe(true);

    const voice: MediaSignals = { kind: 'voice', decoded: true, durationSec: 2, sampleRate: 24000, channels: 1, rms: 0.1, clipping: false, transcript: 'hi', language: 'en' };
    expect(checkMedia(voice, { kind: 'voice', language: 'en' }).passed).toBe(true);
  });

  it('should return a failing verdict (not throw) on a kind mismatch', () => {
    const img: MediaSignals = { kind: 'image', decoded: true, width: 512, height: 512, format: 'png', count: 1, safetyBlocked: false, labels: [], ocrText: '' };
    const exp: MediaExpectation = { kind: 'document', format: 'pdf' };
    const r = checkMedia(img, exp);
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/does not match expectation kind/);
  });

  it('describeCheck should summarize pass and fail', () => {
    expect(describeCheck('Image', { passed: true, score: 9, reasons: [], dimensions: [] })).toMatch(/passed/);
    expect(describeCheck('Image', { passed: false, score: 0, reasons: ['boom'], dimensions: [] })).toMatch(/failed: boom/);
  });
});
