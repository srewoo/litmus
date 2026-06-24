/**
 * Eval suite: extract dimensions, then generate one structured eval prompt per
 * dimension (Athena's per-dimension fan-out). Also combines rubrics into a single
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
  const dimensions = await extractDimensions(systemPrompt, deps, analysisHint);
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
