/** Aggregate per-case judge dimensions into per-version scores for the litmus axis. */
import type { CaseResult, DimensionScore } from '../shared/types';
import { mean, round1 } from './../shared/num';

/** Group dimension scores by name across all cases and average them. */
export function aggregateDimensions(results: readonly CaseResult[]): DimensionScore[] {
  const byName = new Map<string, number[]>();
  for (const r of results) {
    for (const d of r.dimensions ?? []) {
      const list = byName.get(d.dimension);
      if (list) list.push(d.score);
      else byName.set(d.dimension, [d.score]);
    }
  }
  return [...byName.entries()].map(([dimension, scores]) => ({ dimension, score: round1(mean(scores)) }));
}
