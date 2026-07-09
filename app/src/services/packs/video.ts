/**
 * Video evaluator pack (ADR 0007). Pure. Hard gates: decode, safety, duration
 * (within tolerance), resolution, fps, format, audio presence, min frames. Content
 * checks: temporal coherence (flicker below threshold) and per-frame label presence.
 * The coverage note (how many frames were sampled) is surfaced so a bounded sweep
 * never reads as "checked everything" (ADR 0003 no-silent-truncation principle).
 */
import type { VideoExpectation, VideoSignals } from '../../shared/media';
import { round1 } from '../../shared/num';
import { foldChecks, type Check, type CheckResult } from './types';

const DEFAULT_DURATION_TOLERANCE = 0.5;
const DEFAULT_MAX_FLICKER = 0.2;

function presenceFraction(have: readonly string[], wanted: readonly string[]): number {
  if (wanted.length === 0) return 1;
  const hay = have.map((l) => l.toLowerCase());
  return wanted.filter((w) => hay.some((l) => l.includes(w.toLowerCase()))).length / wanted.length;
}

export function checkVideo(signals: VideoSignals, exp: VideoExpectation): CheckResult {
  const reasons: string[] = [];
  const checks: Check[] = [];

  // ---- Hard gates ----
  if (signals.safetyBlocked) reasons.push('video generation was safety-blocked');
  if (!signals.decoded) reasons.push('output did not decode as a valid video');
  if (exp.durationSec !== undefined) {
    const tol = exp.durationToleranceSec ?? DEFAULT_DURATION_TOLERANCE;
    if (Math.abs(signals.durationSec - exp.durationSec) > tol) {
      reasons.push(`duration ${signals.durationSec}s not within ${tol}s of requested ${exp.durationSec}s`);
    }
  }
  if (exp.width !== undefined && signals.width !== exp.width) reasons.push(`width ${signals.width} ≠ requested ${exp.width}`);
  if (exp.height !== undefined && signals.height !== exp.height) reasons.push(`height ${signals.height} ≠ requested ${exp.height}`);
  if (exp.fps !== undefined && signals.fps !== exp.fps) reasons.push(`fps ${signals.fps} ≠ requested ${exp.fps}`);
  if (exp.formats && exp.formats.length > 0 && !exp.formats.map((f) => f.toLowerCase()).includes(signals.format.toLowerCase())) {
    reasons.push(`format ${signals.format} is not one of ${exp.formats.join('/')}`);
  }
  if (exp.hasAudio !== undefined && signals.hasAudio !== exp.hasAudio) {
    reasons.push(exp.hasAudio ? 'expected an audio track, none present' : 'unexpected audio track present');
  }
  if (exp.minFrames !== undefined && signals.frameCount < exp.minFrames) {
    reasons.push(`only ${signals.frameCount} frames, expected ≥ ${exp.minFrames}`);
  }

  // ---- Content checks ----
  const maxFlicker = exp.maxFlicker ?? DEFAULT_MAX_FLICKER;
  checks.push({ dimension: 'temporal_coherence', score: round1(Math.max(0, (1 - signals.flicker) * 10)) });
  if (signals.flicker > maxFlicker) reasons.push(`flicker ${signals.flicker} exceeds max ${maxFlicker}`);

  if (exp.mustContain && exp.mustContain.length > 0) {
    const frac = presenceFraction(signals.labels, exp.mustContain);
    checks.push({ dimension: 'motion_content', score: round1(frac * 10) });
    if (frac < 1) {
      const missing = exp.mustContain.filter((w) => !signals.labels.some((l) => l.toLowerCase().includes(w.toLowerCase())));
      reasons.push(`element(s) not seen across sampled frames: ${missing.join(', ')}`);
    }
  }

  return foldChecks(reasons, checks);
}

/** Coverage note for the rationale — never let a sampled sweep read as exhaustive. */
export function videoCoverageNote(signals: VideoSignals): string {
  return `sampled ${signals.sampledFrames}/${signals.frameCount} frame(s)`;
}
