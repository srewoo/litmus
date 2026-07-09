import { describe, it, expect } from 'vitest';
import { checkVideo, videoCoverageNote } from './video';
import type { VideoSignals } from '../../shared/media';

const base: VideoSignals = {
  decoded: true,
  durationSec: 5,
  width: 1280,
  height: 720,
  fps: 24,
  format: 'mp4',
  hasAudio: false,
  frameCount: 120,
  sampledFrames: 12,
  flicker: 0.05,
  labels: ['a dog running'],
  safetyBlocked: false,
};

describe('checkVideo', () => {
  it('should pass when gates and coherence hold', () => {
    const r = checkVideo(base, { durationSec: 5, width: 1280, height: 720, fps: 24, formats: ['mp4'], mustContain: ['dog'] });
    expect(r.passed).toBe(true);
    expect(r.dimensions.find((d) => d.dimension === 'temporal_coherence')?.score).toBeGreaterThan(9);
  });

  it('should fail when duration is outside tolerance', () => {
    expect(checkVideo(base, { durationSec: 8 }).reasons.join()).toMatch(/duration 5s not within/);
    expect(checkVideo({ ...base, durationSec: 5.3 }, { durationSec: 5 }).passed).toBe(true); // within default 0.5
  });

  it('should fail on resolution / fps / format / audio / frame gates', () => {
    expect(checkVideo(base, { width: 1920 }).reasons.join()).toMatch(/width/);
    expect(checkVideo(base, { fps: 30 }).reasons.join()).toMatch(/fps/);
    expect(checkVideo(base, { formats: ['webm'] }).reasons.join()).toMatch(/format mp4/);
    expect(checkVideo(base, { hasAudio: true }).reasons.join()).toMatch(/expected an audio track/);
    expect(checkVideo({ ...base, hasAudio: true }, { hasAudio: false }).reasons.join()).toMatch(/unexpected audio/);
    expect(checkVideo(base, { minFrames: 200 }).reasons.join()).toMatch(/only 120 frames/);
  });

  it('should fail on excessive flicker and grade the coherence dimension down', () => {
    const r = checkVideo({ ...base, flicker: 0.6 }, {});
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/flicker 0.6 exceeds/);
    expect(r.dimensions.find((d) => d.dimension === 'temporal_coherence')?.score).toBe(4);
  });

  it('should report elements not seen across sampled frames', () => {
    const r = checkVideo({ ...base, labels: ['a cat'] }, { mustContain: ['dog'] });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/not seen across sampled frames.*dog/);
  });

  it('should fail undecodable and safety-blocked output', () => {
    expect(checkVideo({ ...base, decoded: false }, {}).reasons.join()).toMatch(/did not decode/);
    expect(checkVideo({ ...base, safetyBlocked: true }, {}).reasons.join()).toMatch(/safety-blocked/);
  });

  it('videoCoverageNote should surface the sampled fraction (no silent truncation)', () => {
    expect(videoCoverageNote(base)).toBe('sampled 12/120 frame(s)');
  });
});
