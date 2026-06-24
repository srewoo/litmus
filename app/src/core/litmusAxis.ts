/**
 * The litmus axis — the signature visualization. Compares an OLD prompt version
 * against a NEW one, per dimension, as diverging bars. Old grows left (coral),
 * new grows right (teal); width encodes score. Pure and deterministic.
 */
import type { AxisRow, DimensionScore } from '../shared/types';
import { clamp, round1 } from '../shared/num';

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
