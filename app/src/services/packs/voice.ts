/**
 * Voice/audio evaluator pack (ADR 0007). Pure. Hard gates: decode, sample-rate/
 * channels present, duration bounds, non-silence (RMS above floor), no clipping.
 * The load-bearing content check is the ASR ROUND-TRIP: transcribe the output and
 * compare word-error-rate against the requested text — the single most important,
 * fully deterministic TTS assertion. Also: language match and speaker similarity.
 */
import type { VoiceExpectation, VoiceSignals } from '../../shared/media';
import { round1, clamp } from '../../shared/num';
import { foldChecks, type Check, type CheckResult } from './types';

const DEFAULT_MAX_WER = 0.15;
const DEFAULT_MIN_VOICE_SIMILARITY = 0.7;
/** Below this RMS the clip is effectively silent (generation failed). */
const SILENCE_FLOOR = 0.001;

export function checkVoice(signals: VoiceSignals, exp: VoiceExpectation): CheckResult {
  const reasons: string[] = [];
  const checks: Check[] = [];

  // ---- Hard gates ----
  if (!signals.decoded) reasons.push('output did not decode as valid audio');
  if (signals.sampleRate <= 0) reasons.push('audio has no valid sample rate');
  if (signals.channels <= 0) reasons.push('audio has no channels');
  if (signals.rms <= SILENCE_FLOOR) reasons.push('audio is silent (no speech energy)');
  if (signals.clipping) reasons.push('audio clips (distorted peaks)');
  if (exp.minDurationSec !== undefined && signals.durationSec < exp.minDurationSec) {
    reasons.push(`duration ${signals.durationSec}s below min ${exp.minDurationSec}s`);
  }
  if (exp.maxDurationSec !== undefined && signals.durationSec > exp.maxDurationSec) {
    reasons.push(`duration ${signals.durationSec}s above max ${exp.maxDurationSec}s`);
  }

  // ---- Content checks ----
  if (exp.text !== undefined && exp.text.length > 0 && signals.wer !== undefined) {
    const maxWer = exp.maxWer ?? DEFAULT_MAX_WER;
    checks.push({ dimension: 'transcription_accuracy', score: round1(clamp(1 - signals.wer, 0, 1) * 10) });
    if (signals.wer > maxWer) reasons.push(`ASR word-error-rate ${round1(signals.wer)} exceeds max ${maxWer}`);
  }
  if (exp.language !== undefined) {
    const ok = signals.language.toLowerCase().startsWith(exp.language.toLowerCase());
    checks.push({ dimension: 'language_match', score: ok ? 10 : 0 });
    if (!ok) reasons.push(`detected language "${signals.language}" ≠ requested "${exp.language}"`);
  }
  if (exp.voiceId !== undefined && signals.voiceSimilarity !== undefined) {
    const min = exp.minVoiceSimilarity ?? DEFAULT_MIN_VOICE_SIMILARITY;
    checks.push({ dimension: 'voice_similarity', score: round1(clamp(signals.voiceSimilarity, 0, 1) * 10) });
    if (signals.voiceSimilarity < min) {
      reasons.push(`voice similarity ${round1(signals.voiceSimilarity)} below min ${min}`);
    }
  }

  return foldChecks(reasons, checks);
}
