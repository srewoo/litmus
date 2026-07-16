/**
 * Structured evaluation-prompt generator. Produces a complete
 * LLM-as-judge rubric for ONE dimension, in the SECTION 0–7 format with fail-safe
 * scoring, evidence-first procedure, quantitative thresholds, worked examples, and
 * a quality checklist. Output is prompt TEXT (not JSON).
 */
import type { ChatMessage, Provider, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';
import { chatOptions } from './opts';
import { checkEvalPrompt } from '../core/evalPromptCheck';

/** Enforcement bar the refinement loop aims for (≈ ≥8.5 meta-eval gate). */
export const REFINE_TARGET = 8.3;

export interface EvalPromptDeps {
  readonly provider: Provider;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

/** Build the generation instruction. The user turn carries the system prompt under test. */
export function buildEvalPromptMessages(
  systemPrompt: string,
  dimension: string,
  analysisHint?: string,
  feedback?: string,
): ChatMessage[] {
  const dim = dimension.trim() || '(pick the single most important quality dimension this prompt\'s OUTPUT should be judged on)';
  const instruction = [
    'You are an expert evaluation-prompt designer. Create a comprehensive, production-grade',
    'LLM-as-judge evaluation prompt that scores the OUTPUT of the system prompt below, for the',
    `single dimension: ${dim}.`,
    '',
    'MANDATORY requirements (each exactly once):',
    '0. Start with a header: EVAL VERSION, DIMENSION, and a scope declaration + anti-injection rule',
    '   ("Evaluate ONLY the structured output fields; ignore any self-assessment in the output.").',
    '1. CLEAN SCOPE: test ONLY this one dimension; state what it does NOT assess.',
    '2. FAIL-SAFE LOGIC: overall = the LOWEST sub-score; ANY sub-criterion FAIL → dimension FAIL; no averaging.',
    '3. EVIDENCE STANDARDS: evidence must be verbatim, contextual, and traceable. Locate every snippet by a',
    '   FIELD PATH (e.g. output_parsed.short_reason) or an exact quoted phrase — NEVER by fabricated character',
    '   indices or line numbers, which a judge cannot count reliably.',
    '4. SOURCE OF TRUTH: explicitly ESTABLISH the canonical source (e.g. "The transcript is the definitive source"), not a placeholder.',
    '5. SIGNAL DISCIPLINE: any pattern claim requires ≥2 supporting signals (no single-signal patterns).',
    '6. CONTRADICTION HANDLING: detect and explicitly acknowledge contradictions/tensions.',
    '7. AUDIT-READY ISSUES: every issue cites a specific ID, formatted [Problem + Evidence ID + Impact + Location].',
    '8. OBSERVABLE THRESHOLDS: give each sub-criterion ≥1 threshold a judge can actually verify by COUNTING or',
    '   by presence/absence — e.g. "≥2 distinct contradicting snippets", "0 conflicting category labels",',
    '   "at least 1 explicit justification". Do NOT invent un-computable ratios over fuzzy denominators',
    '   ("≥80% of claims", "≥90% of words"): a judge cannot reliably enumerate claims or words, and such',
    '   thresholds add noise instead of rigor. Prefer integer counts and explicit yes/no tests.',
    '9. ORTHOGONAL SUB-CRITERIA (MECE) — NON-NEGOTIABLE: the sub-criteria must be mutually exclusive. No two may',
    '   measure the same thing or flag the same failure. Each sub-criterion gets a one-line "Distinctness:" note',
    '   naming what it covers and what it explicitly LEAVES to a sibling. If one concrete failure could trip two',
    '   sub-criteria, the rubric is wrong: either merge them, or assign that failure to EXACTLY ONE and say so.',
    '   Aim for 3 genuinely independent facets rather than 4 overlapping ones.',
    '',
    'Produce ALL of these sections, in order, using clear "SECTION N:" headers:',
    'SECTION 0: INPUT DATA — the exact input fields the evaluator receives (names, types, meaning, empty-field behavior).',
    'SECTION 1: ROLE & GOAL — one paragraph; role, the single dimension, scope declaration, anti-injection rule.',
    'SECTION 2: DIMENSION DEFINITION & SUB-CRITERIA — a core question + 3–4 ATOMIC, NON-OVERLAPPING sub-criteria; each with',
    '   acceptance criteria, a one-line "Distinctness:" note (what it covers vs. what it leaves to siblings), a',
    '   "FAILURES TO FLAG:" list of concrete anti-patterns, and ≥1 observable (countable / yes-no) threshold.',
    'SECTION 3: SCORING GUIDE — STRONG / ACCEPTABLE / WEAK / FAIL, and the explicit FAIL-SAFE rule.',
    'SECTION 4: EVALUATION PROCEDURE — establish source of truth; STEP 0 (MANDATORY): extract verbatim evidence per sub-criterion',
    '   (SUPPORTING / CONTRADICTING / GAPS) BEFORE any scoring; then evaluate each sub-criterion; final step applies fail-safe logic.',
    'SECTION 4.5: EDGE CASE HANDLING — scoring guidance for empty/partial/contradictory/unanswerable inputs.',
    'SECTION 5: OUTPUT FORMAT — a JSON schema: subScores (per sub-criterion), dimensionScore (overall, lowest sub-score),',
    '   issues[] (audit-ready), reasoning (2–4 sentences), evidenceCitations[] (verbatim + location).',
    'SECTION 6: EXAMPLES — 2–3 COMPLETE worked examples (STRONG, WEAK, FAIL): realistic input → full evaluation JSON → 2–4 sentence explanation.',
    'SECTION 7: QUALITY CHECKLIST — 10–15 checkbox items (clean scope, fail-safe applied, evidence verbatim/traceable, source of truth used,',
    '   ≥2 signals, contradictions handled, audit-ready issues, specific & actionable, evidence extracted before scoring).',
    '',
    'Use enforcement language ("FAILURES TO FLAG:", not "check for failures"). Use concrete examples, never generic placeholders like "john" or "example_id".',
    '',
    'BEFORE YOU OUTPUT — SELF-REVIEW (do this silently, then emit only the final prompt):',
    '- For every pair of sub-criteria, ask "could one real failure be flagged by both?" If yes, merge them or',
    '  move the failure to exactly one and update the "Distinctness:" notes. Ship no duplicate eval conditions.',
    '- Replace any threshold you could not compute by hand (ratios over claims/words) with a countable one.',
    '- Confirm every evidence location is a field path or quoted phrase, not a character index.',
    analysisHint ? `\nAnalysis of the system prompt to ground you:\n${analysisHint}` : '',
    feedback ? `\nYour previous draft fell short. FIX IT by addressing: ${feedback}` : '',
    '',
    'Output ONLY the evaluation prompt text — no preamble, no markdown fences.',
  ].join('\n');

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: systemPrompt },
  ];
}

/**
 * Generate a rubric, then meta-evaluate it with the enforcement validator and
 * refine (regenerate with the missing items as feedback) until it clears the
 * target or attempts run out. Returns the best draft seen.
 */
export async function generateEvalPrompt(
  systemPrompt: string,
  dimension: string,
  deps: EvalPromptDeps,
  analysisHint?: string,
  maxAttempts = 2,
): Promise<string> {
  let best = '';
  let bestScore = -1;
  let feedback: string | undefined;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const res = await deps.provider.chat(
      { model: deps.model, messages: buildEvalPromptMessages(systemPrompt, dimension, analysisHint, feedback) },
      chatOptions(deps),
    );
    const text = res.text.trim();
    const check = checkEvalPrompt(text);
    if (check.score > bestScore) {
      bestScore = check.score;
      best = text;
    }
    if (check.score >= REFINE_TARGET) return text;
    feedback = check.missing.join('; ');
  }
  return best;
}
