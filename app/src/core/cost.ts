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
  return (inputTokens / 1000) * p.in + (outputTokens / 1000) * p.out;
}

export interface EstimateInput {
  readonly caseCount: number;
  readonly targetModel: string;
  readonly judgeModel: string;
  readonly analyzerModel: string;
  readonly includeAnalysis: boolean;
  readonly includeEvalGen: boolean;
  readonly includeFixes: boolean;
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
  const { caseCount, avgInputTokens: ti, avgOutputTokens: to } = input;
  let calls = 0;
  let usd = 0;

  const add = (model: string, n: number): void => {
    calls += n;
    usd += n * costForCall(model, ti, to);
  };

  if (input.includeAnalysis) add(input.analyzerModel, 1);
  if (input.includeEvalGen) add(input.analyzerModel, 1);
  add(input.targetModel, caseCount); // generation
  add(input.judgeModel, caseCount); // judging
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
