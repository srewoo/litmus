/**
 * Core domain types for litmus.
 *
 * The product is an iterative loop over ONE target model:
 *   analyze → suggest → generate evals → run → results → suggest → re-run,
 * saving a PromptVersion each pass. The "litmus axis" compares versions.
 */

export type ProviderId = 'openai' | 'anthropic' | 'google';

export interface TargetModel {
  readonly provider: ProviderId;
  readonly model: string;
}

/* ---- Analysis (the core read of a prompt, for a given target) ---- */

export type AnalysisFacet = 'language' | 'intent' | 'format' | 'tone';

export interface FacetScore {
  readonly facet: AnalysisFacet;
  /** 0–10. */
  readonly score: number;
  readonly finding: string;
}

export interface PromptAnalysis {
  readonly facets: readonly FacetScore[];
  /** Concrete, applyable rewrite suggestions. */
  readonly suggestions: readonly string[];
}

/* ---- Eval cases ---- */

export type CaseCategory = 'typical' | 'edge' | 'adversarial';

export interface EvalCase {
  readonly id: string;
  readonly category: CaseCategory;
  readonly input: string;
  readonly note?: string;
  readonly pinned: boolean;
}

/* ---- Run results (quality + speed) ---- */

export interface Timing {
  /** Time to first byte, ms. */
  readonly ttfbMs: number;
  /** Total response time, ms. */
  readonly totalMs: number;
  readonly tokens: number;
  readonly tokensPerSec: number;
}

export interface CaseResult {
  readonly caseId: string;
  readonly output: string;
  /** 0–10 judge score. */
  readonly score: number;
  readonly passed: boolean;
  readonly rationale: string;
  readonly timing: Timing;
  /** Optional per-dimension judge scores, used to build the version litmus axis. */
  readonly dimensions?: readonly DimensionScore[];
}

export interface SpeedAggregate {
  readonly ttfbMs: number;
  readonly avgResponseMs: number;
  readonly tokensPerSec: number;
}

export interface RunSummary {
  /** Mean case score, 0–10. */
  readonly overall: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly total: number;
  readonly speed: SpeedAggregate;
}

/* ---- Versions & the litmus axis ---- */

export interface PromptVersion {
  readonly id: string;
  /** 1-based: v1, v2, v3… */
  readonly index: number;
  readonly text: string;
  readonly createdAt: number;
  readonly parentId: string | null;
  readonly note: string;
}

export interface DimensionScore {
  readonly dimension: string;
  /** 0–10. */
  readonly score: number;
}

/** One row of the litmus axis: an old version vs a new version on a dimension. */
export interface AxisRow {
  readonly dimension: string;
  readonly oldScore: number;
  readonly newScore: number;
  /** Half-track bar widths (0–50%) for the diverging visualization. */
  readonly oldWidthPct: number;
  readonly newWidthPct: number;
  readonly improved: boolean;
}
