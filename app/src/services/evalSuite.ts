/**
 * Eval suite: extract dimensions, then generate one structured eval prompt per
 * dimension. Also combines rubrics into a single
 * judge instruction for the run. The optional onProgress hook lets the UI report
 * which dimension is generating.
 */
import type { Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import { extractDimensions } from './dimensionExtract';
import type { Dimension } from './dimensionExtract';
import { generateEvalPrompt } from './evalPrompt';

export interface SuiteDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export interface EvalSuite {
  readonly dimensions: Dimension[];
  /** dimension name → generated eval-prompt text. */
  readonly rubrics: Record<string, string>;
}

export async function generateEvalSuite(
  systemPrompt: string,
  deps: SuiteDeps,
  analysisHint?: string,
  onProgress?: (dimension: string, index: number, total: number) => void,
): Promise<EvalSuite> {
  const extracted = await extractDimensions(systemPrompt, deps, analysisHint);
  // rubrics is keyed by dimension name, so duplicate names would collapse into
  // one rubric while `dimensions` still listed both — progress would report N
  // rubrics when only N-1 exist. Drop duplicates (first occurrence wins) so the
  // rubric count always matches the dimension count.
  const seen = new Set<string>();
  const dimensions: Dimension[] = [];
  for (const d of extracted) {
    if (d && !seen.has(d.name)) {
      seen.add(d.name);
      dimensions.push(d);
    }
  }
  const rubrics: Record<string, string> = {};
  for (let i = 0; i < dimensions.length; i++) {
    const d = dimensions[i];
    if (!d) continue;
    onProgress?.(d.name, i + 1, dimensions.length);
    const hint = `${analysisHint ?? ''}\nDimension: ${d.name} — ${d.description}`.trim();
    rubrics[d.name] = await generateEvalPrompt(systemPrompt, d.name, deps, hint);
  }
  return { dimensions, rubrics };
}

/** Combine per-dimension rubrics into one judge instruction. */
export function combineRubrics(rubrics: Record<string, string>): string {
  return Object.entries(rubrics)
    .map(([name, text]) => `### DIMENSION: ${name}\n${text}`)
    .join('\n\n');
}
