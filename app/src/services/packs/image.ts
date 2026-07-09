/**
 * Image evaluator pack (ADR 0007). Pure: given the signals the injected checkers
 * extracted from a generated image and what the prompt asked for, decide pass/fail
 * deterministically. Hard gates (decode, safety, format, dimensions, count) block
 * the pass; content checks (object presence, negatives, OCR text, edit-consistency)
 * add graded dimensions to the litmus axis. No LLM here.
 */
import type { ImageExpectation, ImageSignals } from '../../shared/media';
import { round1 } from '../../shared/num';
import { foldChecks, type Check, type CheckResult } from './types';

/** Fraction (0–1) of `wanted` labels present in `have`, matched case-insensitively as substrings. */
function presenceFraction(have: readonly string[], wanted: readonly string[]): number {
  if (wanted.length === 0) return 1;
  const hay = have.map((l) => l.toLowerCase());
  const hits = wanted.filter((w) => hay.some((l) => l.includes(w.toLowerCase()))).length;
  return hits / wanted.length;
}

export function checkImage(signals: ImageSignals, exp: ImageExpectation): CheckResult {
  const reasons: string[] = [];
  const checks: Check[] = [];

  // ---- Hard gates ----
  if (signals.safetyBlocked) reasons.push('image generation was safety-blocked');
  if (!signals.decoded) reasons.push('output did not decode as a valid image');
  if (exp.formats && exp.formats.length > 0 && !exp.formats.map((f) => f.toLowerCase()).includes(signals.format.toLowerCase())) {
    reasons.push(`format ${signals.format} is not one of ${exp.formats.join('/')}`);
  }
  if (exp.width !== undefined && signals.width !== exp.width) reasons.push(`width ${signals.width} ≠ requested ${exp.width}`);
  if (exp.height !== undefined && signals.height !== exp.height) reasons.push(`height ${signals.height} ≠ requested ${exp.height}`);
  if (exp.count !== undefined && signals.count !== exp.count) reasons.push(`returned ${signals.count} image(s), requested ${exp.count}`);

  // ---- Content checks (graded dimensions; a miss also blocks the pass) ----
  if (exp.mustContain && exp.mustContain.length > 0) {
    const frac = presenceFraction(signals.labels, exp.mustContain);
    checks.push({ dimension: 'object_presence', score: round1(frac * 10) });
    if (frac < 1) {
      const missing = exp.mustContain.filter((w) => !signals.labels.some((l) => l.toLowerCase().includes(w.toLowerCase())));
      reasons.push(`missing requested element(s): ${missing.join(', ')}`);
    }
  }
  if (exp.mustNotContain && exp.mustNotContain.length > 0) {
    const present = exp.mustNotContain.filter((w) => signals.labels.some((l) => l.toLowerCase().includes(w.toLowerCase())));
    checks.push({ dimension: 'negative_adherence', score: present.length === 0 ? 10 : 0 });
    if (present.length > 0) reasons.push(`forbidden element(s) present: ${present.join(', ')}`);
  }
  if (exp.text !== undefined && exp.text.length > 0) {
    const ok = signals.ocrText.toLowerCase().includes(exp.text.toLowerCase());
    checks.push({ dimension: 'text_render', score: ok ? 10 : 0 });
    if (!ok) reasons.push(`requested text "${exp.text}" not found in image`);
  }
  if (exp.maxRefDistance !== undefined && signals.refDistance !== undefined) {
    const ok = signals.refDistance <= exp.maxRefDistance;
    // Linear: 0 distance → 10, at-threshold → ~5, beyond → clamps toward 0.
    const score = round1(Math.max(0, 10 - (signals.refDistance / Math.max(exp.maxRefDistance, 1e-6)) * 5));
    checks.push({ dimension: 'edit_consistency', score });
    if (!ok) reasons.push(`edit changed too much (distance ${signals.refDistance} > ${exp.maxRefDistance})`);
  }

  return foldChecks(reasons, checks);
}
