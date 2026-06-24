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

/* ---- Tools (Tier 1: single-turn tool-call assertions; see ADR 0001) ---- */

/** A tool the target model may call. `parameters` is a JSON Schema object. */
export interface ToolDef {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
}

/** A tool invocation parsed from a model response. `arguments` is the parsed JSON. */
export interface ToolCall {
  readonly name: string;
  readonly arguments: unknown;
  /** Raw argument string as returned — kept for diagnostics when parsing fails. */
  readonly rawArguments?: string;
}

/**
 * What a case asserts about the model's tool use, checked deterministically.
 * All fields optional so a case can assert just one aspect.
 */
export interface ToolExpectation {
  /** The tool that should be called (must appear among the calls). */
  readonly expectedTool?: string;
  /** Tools that must NOT be called. */
  readonly forbiddenTools?: readonly string[];
  /** Arguments the expected tool's call must contain (exact value match, subset). */
  readonly requiredArgs?: Readonly<Record<string, unknown>>;
}

/* ---- Agent scenarios (Tier 2: multi-turn runs with mock tools; see ADR 0002) ---- */

/** A mock tool's response for one call: a value, or an injected failure. */
export type MockResult = { readonly value?: unknown } | { readonly error: string };

/** A tool the agent may call during a scenario, with scripted (deterministic) responses. */
export interface MockTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
  /** Response per call index; the last entry repeats for further calls. Empty → empty object. */
  readonly results: readonly MockResult[];
}

/** A multi-turn task: a goal, the mock tools available, and termination bounds. */
export interface Scenario {
  /** The user's task — becomes the first user message. */
  readonly goal: string;
  readonly tools: readonly MockTool[];
  /** Hard cap on agent loop iterations (model turns). */
  readonly maxSteps: number;
  /** Optional substrings the final answer must contain (case-insensitive) to pass. */
  readonly successContains?: readonly string[];
}

/* ---- Eval cases ---- */

export type CaseCategory = 'typical' | 'edge' | 'adversarial';

export interface EvalCase {
  readonly id: string;
  readonly category: CaseCategory;
  readonly input: string;
  readonly note?: string;
  readonly pinned: boolean;
  /** When set, the case is scored on tool use (ADR 0001) instead of text. */
  readonly toolExpectations?: ToolExpectation;
  /** When set, the case is a multi-turn agent run (ADR 0002). */
  readonly scenario?: Scenario;
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

/** Spread across repeated samples of one case (variance), when samples > 1. */
export interface SampleStats {
  readonly count: number;
  readonly scores: readonly number[];
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly stdev: number;
  /** Fraction of samples that passed the threshold (0–1). */
  readonly passRate: number;
}

export interface CaseResult {
  readonly caseId: string;
  readonly output: string;
  /** 0–10 score (the mean across samples when sampled more than once). */
  readonly score: number;
  readonly passed: boolean;
  readonly rationale: string;
  readonly timing: Timing;
  /** Optional per-dimension scores, used to build the version litmus axis. */
  readonly dimensions?: readonly DimensionScore[];
  /** Present when the case was run more than once — its run-to-run spread. */
  readonly samples?: SampleStats;
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
