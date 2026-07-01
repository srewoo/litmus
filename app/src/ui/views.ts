/**
 * Pure HTML builders for the panel's dynamic content. Kept separate from the
 * controller so they're unit-testable and so all user text is escaped in one place.
 */
import type { AxisRow, CaseResult, EvalCase, FacetScore, RunSummary, AnalysisFacet } from '../shared/types';
import { failingFirst } from '../core/results';
import { round1 } from '../shared/num';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function band(score: number): 'hi' | 'mid' | 'lo' {
  return score >= 7.5 ? 'hi' : score >= 5 ? 'mid' : 'lo';
}

/** One bubble in the prompt-builder interview transcript. */
export interface BuilderTurnVM {
  readonly who: 'you' | 'litmus';
  readonly text: string;
  /** Quick-reply chips shown under a litmus question. */
  readonly suggestions?: readonly string[];
}

/** Render the builder interview transcript. Suggestion chips carry their text in data-fill. */
export function builderLogHtml(turns: readonly BuilderTurnVM[]): string {
  return turns
    .map((t) => {
      const chips = (t.suggestions ?? [])
        .map((s) => `<button class="sugg" data-fill="${esc(s)}">${esc(s)}</button>`)
        .join('');
      const chipWrap = chips ? `<div class="suggrow">${chips}</div>` : '';
      return `<div class="bub ${t.who === 'you' ? 'you' : 'lit'}"><div class="bub-txt">${esc(t.text)}</div>${chipWrap}</div>`;
    })
    .join('');
}

const FACET_ICON: Record<AnalysisFacet, string> = { language: '✎', intent: '◎', format: '{ }', tone: '◑' };

export function facetRowsHtml(facets: readonly FacetScore[]): string {
  return facets
    .map((f) => {
      const b = band(f.score);
      const name = f.facet.charAt(0).toUpperCase() + f.facet.slice(1);
      const width = Math.max(0, Math.min(10, f.score)) * 10;
      return (
        `<div class="facet"><div class="fr"><span class="fn"><span>${FACET_ICON[f.facet] ?? '•'}</span>${name}</span>` +
        `<span class="fsc ${b}">${f.score.toFixed(1)}</span></div>` +
        `<div class="fbar"><i class="bar-${b}" style="width:${width}%"></i></div>` +
        `<div class="fnote">${esc(f.finding)}</div></div>`
      );
    })
    .join('');
}

/**
 * Analysis rewrite suggestions. The text is model-generated, so it MUST be
 * escaped before it reaches innerHTML — a suggestion containing markup would
 * otherwise inject into the panel that holds the user's API keys.
 */
export function suggestionsHtml(suggestions: readonly string[]): string {
  return suggestions.map((s) => `<div class="sd">✦ ${esc(s)}</div>`).join('');
}

const CAT_CLASS: Record<EvalCase['category'], string> = { typical: 'typ', edge: 'edge', adversarial: 'adv' };

export function casesListHtml(cases: readonly EvalCase[]): string {
  if (cases.length === 0) return '<p class="sub">No cases yet.</p>';
  return cases
    .map((c, i) => {
      const tool = c.scenario
        ? `<span class="ctag">🤖 agent · ${c.scenario.maxSteps} steps</span>`
        : c.toolExpectations
          ? `<span class="ctag">🔧 ${esc(c.toolExpectations.expectedTool ?? 'tool test')}</span>`
          : '';
      return (
        `<div class="case"><span class="cat ${CAT_CLASS[c.category]}"></span>` +
        `<div class="cx"><div class="ct">${c.category}${tool}</div><div class="cb">${esc(c.input)}</div></div>` +
        `<button class="rm" data-i="${i}" title="Remove">✕</button></div>`
      );
    })
    .join('');
}

export function speedStripHtml(speed: RunSummary['speed']): string {
  return (
    `<div class="mstrip">` +
    `<div><div class="mk">TTFB</div><div class="mv">${round1(speed.ttfbMs / 1000)}s</div></div>` +
    `<div><div class="mk">Avg resp</div><div class="mv">${round1(speed.avgResponseMs / 1000)}s</div></div>` +
    `<div><div class="mk">Tokens/s</div><div class="mv">${speed.tokensPerSec}</div></div>` +
    `</div>`
  );
}

/* ---- Per-case expandable detail (question · tools called · response · why) ---- */

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function prop(v: unknown, k: string): unknown {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined;
}
function compact(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}
function dfield(label: string, body: string): string {
  return `<div class="dfield"><div class="dlabel">${esc(label)}</div>${body}</div>`;
}
function dtext(s: string): string {
  return `<div class="dtext">${esc(s || '(empty)')}</div>`;
}

/** One agent-trajectory step: model text + the tool calls it made and their results. */
function trajectoryStepHtml(step: unknown, i: number): string {
  const text = compact(prop(step, 'modelText'));
  const calls = (Array.isArray(prop(step, 'toolCalls')) ? (prop(step, 'toolCalls') as unknown[]) : [])
    .map((tc) => `<code>${esc(compact(prop(tc, 'name')))}(${esc(compact(prop(tc, 'arguments')))})</code>`)
    .join(' ');
  const results = (Array.isArray(prop(step, 'toolResults')) ? (prop(step, 'toolResults') as unknown[]) : [])
    .map((tr) => `<span class="dres">→ ${esc(compact(prop(tr, 'result')))}</span>`)
    .join(' ');
  const callLine = calls ? `<div class="dcall">${calls} ${results}</div>` : '';
  return `<div class="dstep"><span class="dstepn">${i + 1}</span><div>${text ? dtext(text) : ''}${callLine}</div></div>`;
}

/**
 * Expandable detail for one result row: the question asked, what tools were
 * called (for tool/agent cases) or the model's response (for quality cases),
 * the per-dimension scores, and the full rationale. Hidden until the row is
 * clicked. Robust to the different `output` encodings (text, tool-call array,
 * trajectory object).
 */
export function caseDetailHtml(r: CaseResult, c?: EvalCase): string {
  const parts: string[] = [dfield('Question', dtext(c?.input ?? r.caseId))];

  if (c?.scenario) {
    const traj = parseJson(r.output);
    const steps = Array.isArray(prop(traj, 'steps')) ? (prop(traj, 'steps') as unknown[]) : [];
    parts.push(dfield('Trajectory', steps.length ? steps.map(trajectoryStepHtml).join('') : dtext('No steps.')));
    const final = compact(prop(traj, 'finalText'));
    if (final) parts.push(dfield('Final answer', dtext(final)));
  } else if (c?.toolExpectations) {
    const calls = parseJson(r.output);
    const list = Array.isArray(calls) && calls.length
      ? calls
          .map((tc) => `<div class="dcall"><code>${esc(compact(prop(tc, 'name')))}</code> <span class="dargs">${esc(compact(prop(tc, 'arguments') ?? prop(tc, 'rawArguments')))}</span></div>`)
          .join('')
      : dtext('No tool was called.');
    parts.push(dfield('Tools called', list));
    const exp = c.toolExpectations;
    const expBits = [
      exp.expectedTool ? `expected: ${exp.expectedTool}` : '',
      exp.forbiddenTools?.length ? `forbidden: ${exp.forbiddenTools.join(', ')}` : '',
      exp.requiredArgs ? `required args: ${compact(exp.requiredArgs)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (expBits) parts.push(dfield('Expected', dtext(expBits)));
  } else {
    parts.push(dfield('Response', dtext(r.output)));
  }

  if (r.dimensions?.length) {
    const dims = r.dimensions.map((d) => `<span class="ddim">${esc(d.dimension)} ${d.score.toFixed(1)}</span>`).join('');
    parts.push(dfield('Dimensions', `<div class="ddims">${dims}</div>`));
  }
  parts.push(dfield('Why', dtext(r.rationale)));
  return `<div class="mdetail hidden">${parts.join('')}</div>`;
}

export function resultsTableHtml(
  results: readonly CaseResult[],
  threshold: number,
  cases: readonly EvalCase[] = [],
): string {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const ordered = failingFirst(results, threshold);
  const rows = ordered
    .map((r) => {
      const b = band(r.score);
      const mark = r.passed ? '<span class="pf p">✓</span>' : '<span class="pf f">✕</span>';
      const c = byId.get(r.caseId);
      // Show the case's actual input as the detail; fall back to the id if unknown.
      const detail = c?.input.trim() ? c.input.trim().replace(/\s+/g, ' ') : r.caseId;
      const cat = c ? ` · ${c.category}` : '';
      const tip = `${r.caseId}${cat}\n\n${c?.input ?? ''}\n\n— ${r.rationale}`.trim();
      const idTag = `<span class="cid">${esc(r.caseId)}</span>`;
      // Spread badge when the case was sampled more than once.
      const spread = r.samples
        ? r.samples.min === r.samples.max
          ? `<span class="spread">×${r.samples.count}</span>`
          : `<span class="spread">${r.samples.min}–${r.samples.max}</span>`
        : '';
      // Non-color cue for the score: an aria-label spells out the value and
      // pass/fail so screen readers and colorblind users aren't relying on hue.
      const scoreAria = `score ${r.score.toFixed(1)}, ${r.passed ? 'passed' : 'failed'}`;
      // Three score states so a borderline "mid" band is visually distinct from
      // a clearly passing cell, not collapsed into 'ok'. The CSS styles .cell.mid
      // (amber + a non-color cue). Pass/fail stays driven by the real pass logic.
      const cellClass = b === 'hi' ? 'cell ok' : b === 'mid' ? 'cell mid' : 'cell lo';
      return (
        `<div class="mrow" data-cid="${esc(r.caseId)}" title="${esc(tip)}"><div class="cse"><span class="caret">▸</span>${idTag}${esc(detail)}</div>` +
        `<div class="${cellClass}" aria-label="${esc(scoreAria)}">${r.score.toFixed(1)}${spread}</div>` +
        `<div class="cell">${mark}</div></div>` +
        caseDetailHtml(r, c)
      );
    })
    .join('');
  return `<div class="matrix"><div class="mhead"><div>Case</div><div>Score</div><div>P/F</div></div>${rows}</div>`;
}

export interface FixVM {
  readonly title: string;
  readonly edit: string;
  readonly caseRef?: string;
}

export function fixesListHtml(fixes: readonly FixVM[]): string {
  if (fixes.length === 0) return '<p class="sub">No material weaknesses found. 🎉</p>';
  return fixes
    .map((f, i) => {
      const evid = f.caseRef ? `<div class="evid">▸ from <b>${esc(f.caseRef)}</b></div>` : '';
      return (
        `<div class="fix"><div class="ft"><span class="rk">${String(i + 1).padStart(2, '0')}</span>` +
        `<span class="fh">${esc(f.title)}</span></div><p class="fp">${esc(f.edit)}</p>${evid}</div>`
      );
    })
    .join('');
}

/**
 * One inline glossary term. The definition is surfaced three ways so it
 * reaches mouse, keyboard and AT users alike: a visible `title=` (hover),
 * `tabindex="0"` (keyboard focusable), `role="note"` + `aria-label` (the
 * definition is announced on focus). `inner` is already-escaped HTML.
 */
function termHtml(definition: string, inner: string): string {
  const def = esc(definition);
  return `<span class="term" title="${def}" tabindex="0" role="note" aria-label="${def}">${inner}</span>`;
}

/**
 * Header for the litmus-axis panel. Wraps the coined label in an inline
 * glossary term so the plain-language definition is one hover/focus away.
 */
export function axisHeaderHtml(label = 'By dimension'): string {
  return termHtml(TERM_LITMUS_AXIS, esc(label));
}

/** The litmus axis: diverging bars comparing an old version (coral) vs new (teal). */
export function axisRowsHtml(rows: readonly AxisRow[]): string {
  return rows
    .map(
      (r) =>
        `<div class="dim"><div class="dl"><span>${esc(r.dimension)}</span>` +
        `<span><span class="sa">${r.oldScore.toFixed(1)}</span> · <span class="sb">${r.newScore.toFixed(1)}</span></span></div>` +
        `<div class="track"><span class="mid"></span>` +
        `<span class="ba" style="width:${r.oldWidthPct}%"></span>` +
        `<span class="bb" style="width:${r.newWidthPct}%"></span></div></div>`,
    )
    .join('');
}

/** Coverage matrix: each instruction → its dimension, NOT-TESTED gaps flagged. */
export function coverageHtml(rows: ReadonlyArray<{ instruction: string; dimension: string | null }>): string {
  if (rows.length === 0) return '<p class="sub">No coverage data yet.</p>';
  const gaps = rows.filter((r) => r.dimension === null).length;
  const head = `<div class="covsum">${rows.length - gaps}/${rows.length} instructions covered${gaps ? ` · ${gaps} NOT TESTED` : ' ✓'}</div>`;
  const body = rows
    .map(
      (r) =>
        `<div class="covrow"><span class="covi">${esc(r.instruction)}</span>` +
        (r.dimension
          ? `<span class="covd ok">${esc(r.dimension)}</span>`
          : `<span class="covd gap">NOT TESTED</span>`) +
        `</div>`,
    )
    .join('');
  return head + body;
}

const TERM_RUBRIC_HEALTH =
  'How well your scoring rubric separates strong from weak answers.';
const TERM_DISCRIMINATION =
  'Whether the rubric gives clearly different scores to strong vs weak outputs. Higher gap = better separation.';
const TERM_CONSISTENCY =
  'How stable scores are when the same output is judged repeatedly (lower variation = more consistent).';
const TERM_LITMUS_AXIS =
  'What changed between two versions, broken down by quality dimension.';

/**
 * Rubric-health summary. Leads with a plain one-line verdict (always visible)
 * and tucks the numeric discrimination/consistency detail inside an Advanced
 * disclosure so the statistics are one click deeper.
 */
export function rubricHealthHtml(health: {
  discrimination: { gap: number; rating: string };
  consistency: { stdDev: number; rating: string };
}): string {
  const verdict =
    `Discrimination <b>${esc(health.discrimination.rating)}</b>` +
    ` · Consistency <b>${esc(health.consistency.rating)}</b>`;
  return (
    `<div class="rh-summary">${termHtml(TERM_RUBRIC_HEALTH, 'Rubric health')}: ${verdict}</div>` +
    `<details class="adv"><summary>Rubric health detail</summary>` +
    `<span class="rh-disc">${termHtml(TERM_DISCRIMINATION, 'Discrimination')} ${esc(health.discrimination.rating)} (${health.discrimination.gap.toFixed(1)})</span>` +
    ` · <span class="rh-cons">${termHtml(TERM_CONSISTENCY, 'Consistency')} σ${health.consistency.stdDev.toFixed(1)} (${esc(health.consistency.rating)})</span>` +
    `</details>`
  );
}

export interface VersionVM {
  readonly label: string;
  readonly note: string;
  readonly overall: number;
  readonly passLabel: string;
  readonly avgSeconds: number;
  readonly delta: number | null;
  readonly current: boolean;
  /** The model this version ran on, shown as a chip; absent on legacy versions. */
  readonly model?: string;
}

export function versionsTimelineHtml(items: readonly VersionVM[]): string {
  if (items.length === 0) return '<p class="sub">No versions yet — run the loop to save v1.</p>';
  const rows = items
    .map((v) => {
      const deltaHtml =
        v.delta === null
          ? '<span class="vd flat">baseline</span>'
          : `<span class="vd ${v.delta >= 0 ? 'up' : 'down'}">${v.delta >= 0 ? '▲ +' : '▼ '}${Math.abs(v.delta).toFixed(1)}</span>`;
      const cur = v.current ? '<span class="vcur">current</span>' : '';
      const model = v.model ? `<span class="vmodel" title="ran on ${esc(v.model)}">${esc(v.model)}</span>` : '';
      return (
        `<div class="ver${v.delta === null ? ' base' : ''}"><div class="vh"><span class="vt">${esc(v.label)}</span>${cur}${model}${deltaHtml}` +
        `<span class="vsc">${v.overall.toFixed(1)} · ${esc(v.passLabel)} · ${v.avgSeconds}s</span></div>` +
        `<div class="vnote">${esc(v.note)}</div></div>`
      );
    })
    .join('');
  return `<div class="vtl">${rows}</div>`;
}
