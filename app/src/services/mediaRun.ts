/**
 * Media case execution (ADR 0007). The generation + signal-extraction pipeline is
 * an INJECTED seam (`MediaGenerator`): given a case, it produces the artifact and
 * the checker signals (a BYOK generation call + WASM/BYOK checkers — never bundled
 * here). This module pairs those signals with the case's expectation, runs the
 * pure pack verdict, and assembles a CaseResult in the same shape the tool/agent
 * paths use — so `foldSamples`/`summarizeRun`/the litmus axis need no media code.
 */
import type { CaseResult, EvalCase, Timing } from '../shared/types';
import type { MediaSignals } from '../shared/media';
import { checkMedia, describeCheck, videoCoverageNote } from './packs';

export interface MediaGenContext {
  readonly systemPrompt: string;
  readonly signal?: AbortSignal;
}

export interface MediaGenResult {
  readonly signals: MediaSignals;
  readonly timing: Timing;
}

/** Generate the artifact for a media case and extract its checker signals. */
export type MediaGenerator = (evalCase: EvalCase, ctx: MediaGenContext) => Promise<MediaGenResult>;

function titleCase(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export async function mediaCaseResult(
  systemPrompt: string,
  evalCase: EvalCase,
  generator: MediaGenerator,
  signal?: AbortSignal,
): Promise<CaseResult> {
  const expectation = evalCase.media!;
  const { signals, timing } = await generator(evalCase, { systemPrompt, ...(signal ? { signal } : {}) });
  const verdict = checkMedia(signals, expectation);
  let rationale = describeCheck(titleCase(expectation.kind), verdict);
  // Never let a bounded frame sweep read as exhaustive (ADR 0003 principle).
  if (signals.kind === 'video') rationale += ` · ${videoCoverageNote(signals)}`;
  return {
    caseId: evalCase.id,
    output: JSON.stringify(signals),
    score: verdict.score,
    passed: verdict.passed,
    rationale,
    timing,
    ...(verdict.dimensions.length ? { dimensions: verdict.dimensions } : {}),
  };
}
