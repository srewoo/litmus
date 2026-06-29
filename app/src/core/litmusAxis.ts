/**
 * The litmus axis — the signature visualization. Compares an OLD prompt version
 * against a NEW one, per dimension, as diverging bars. Old grows left (coral),
 * new grows right (teal); width encodes score. Pure and deterministic.
 */
import type { AxisRow, DimensionScore } from '../shared/types';
import { clamp, round1 } from '../shared/num';

/** What differs between the two versions placed on the axis. */
export type ComparisonKind = 'model' | 'prompt' | 'both' | 'same';

/** Minimal version shape the comparison needs — keeps core free of the store. */
export interface ComparisonSide {
  readonly label: string;
  readonly promptText: string;
  /** The target model id, if recorded for this version. */
  readonly model?: string;
}

export interface Comparison {
  readonly kind: ComparisonKind;
  /** Human header for the axis, e.g. "Model · gpt-5.5 vs claude-opus-4-8". */
  readonly header: string;
}

/**
 * Classify what changed between two versions and produce the axis header.
 * Model comparison is the headline case: identical prompt text run on two
 * different models. Pure and deterministic.
 */
export function describeComparison(a: ComparisonSide, b: ComparisonSide): Comparison {
  const samePrompt = a.promptText === b.promptText;
  // Models only count as "different" when both sides recorded one.
  const modelChanged = Boolean(a.model && b.model && a.model !== b.model);
  if (samePrompt && modelChanged) {
    return { kind: 'model', header: `Model · ${a.model} vs ${b.model}` };
  }
  if (!samePrompt && modelChanged) {
    return { kind: 'both', header: `${a.label} → ${b.label} · prompt + model (${a.model} vs ${b.model})` };
  }
  if (!samePrompt) {
    return { kind: 'prompt', header: `Prompt · ${a.label} → ${b.label}` };
  }
  return { kind: 'same', header: `${a.label} → ${b.label} · identical prompt & model` };
}

/** Map a 0–10 score onto a half-track width (0–50%) for the diverging bar. */
export function scoreToHalfWidth(score: number): number {
  return round1((clamp(score, 0, 10) / 10) * 50);
}

/**
 * Build axis rows from old and new dimension scores. Rows follow the old
 * version's dimension order; a dimension missing from the new set keeps its
 * old score (treated as unchanged).
 */
export function buildAxis(
  oldDims: readonly DimensionScore[],
  newDims: readonly DimensionScore[],
): AxisRow[] {
  const newByDim = new Map(newDims.map((d) => [d.dimension, d.score]));
  return oldDims.map((o) => {
    const newScore = newByDim.get(o.dimension) ?? o.score;
    return {
      dimension: o.dimension,
      oldScore: o.score,
      newScore,
      oldWidthPct: scoreToHalfWidth(o.score),
      newWidthPct: scoreToHalfWidth(newScore),
      improved: newScore > o.score,
    };
  });
}

/** Signed overall delta between two versions (positive = improved). */
export function overallDelta(oldOverall: number, newOverall: number): number {
  return round1(newOverall - oldOverall);
}
