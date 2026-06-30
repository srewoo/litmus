/**
 * Pre-run cost estimation (PRD §8 / F9). Pure: given the loop shape and rough
 * token sizes, estimate total calls and USD so the panel can show a number and
 * enforce a spend cap before any money is spent on the user's key.
 */

export interface ModelPrice {
  /** USD per 1K input tokens. */
  readonly in: number;
  /** USD per 1K output tokens. */
  readonly out: number;
}

/** Rough public prices; fallback applied for unknown models. Update as needed. */
export const PRICES: Record<string, ModelPrice> = {
  'gpt-5.1': { in: 0.005, out: 0.015 },
  'gpt-5.1-mini': { in: 0.0006, out: 0.0024 },
  'claude-sonnet-4.6': { in: 0.003, out: 0.015 },
  'gemini-2.5-pro': { in: 0.00125, out: 0.005 },
};

export const DEFAULT_PRICE: ModelPrice = { in: 0.005, out: 0.015 };

export function priceFor(model: string): ModelPrice {
  return PRICES[model] ?? DEFAULT_PRICE;
}

export function costForCall(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  // Clamp negative token counts to 0 — a negative count is nonsensical and would
  // otherwise produce a negative (under-reported) cost.
  const ti = Math.max(0, inputTokens);
  const to = Math.max(0, outputTokens);
  return (ti / 1000) * p.in + (to / 1000) * p.out;
}

export interface EstimateInput {
  readonly caseCount: number;
  readonly targetModel: string;
  readonly judgeModel: string;
  readonly analyzerModel: string;
  readonly includeAnalysis: boolean;
  readonly includeEvalGen: boolean;
  readonly includeFixes: boolean;
  /**
   * Whether each case incurs an LLM judge call. Quality cases are judged;
   * tool/agent cases are scored deterministically (no judge). Defaults to true
   * for backward compatibility — pass false for deterministic runs.
   */
  readonly includeJudge?: boolean;
  /**
   * Judge calls per quality case. With ensemble judging (judge-variance
   * reduction) each case is judged this many times. Defaults to 1.
   */
  readonly judgeSamples?: number;
  readonly avgInputTokens: number;
  readonly avgOutputTokens: number;
}

export interface CostEstimate {
  readonly totalCalls: number;
  readonly estUsd: number;
}

/** Round USD to 4 dp (sub-cent precision matters for cheap runs). */
function roundUsd(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function estimateRun(input: EstimateInput): CostEstimate {
  // Clamp negative counts to 0 so a bad input can never under-report calls/cost
  // or weaken the spend cap.
  const caseCount = Math.max(0, input.caseCount);
  const ti = Math.max(0, input.avgInputTokens);
  const to = Math.max(0, input.avgOutputTokens);
  let calls = 0;
  let usd = 0;

  const add = (model: string, n: number): void => {
    calls += n;
    usd += n * costForCall(model, ti, to);
  };

  if (input.includeAnalysis) add(input.analyzerModel, 1);
  if (input.includeEvalGen) add(input.analyzerModel, 1);
  add(input.targetModel, caseCount); // generation
  if (input.includeJudge !== false) {
    const judgeSamples = Math.max(1, Math.floor(input.judgeSamples ?? 1));
    add(input.judgeModel, caseCount * judgeSamples); // judging (×N for an ensemble)
  }
  if (input.includeFixes) add(input.analyzerModel, 1);

  return { totalCalls: calls, estUsd: roundUsd(usd) };
}

/** Would this estimate exceed the user's hard cap? */
export function exceedsCap(estimate: CostEstimate, capUsd: number): boolean {
  return estimate.estUsd > capUsd;
}

/** Human-friendly USD label, e.g. "~$0.18". */
export function formatUsd(usd: number): string {
  return usd < 0.01 ? `~$${usd.toFixed(4)}` : `~$${usd.toFixed(2)}`;
}
