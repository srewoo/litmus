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

const CAT_CLASS: Record<EvalCase['category'], string> = { typical: 'typ', edge: 'edge', adversarial: 'adv' };

export function casesListHtml(cases: readonly EvalCase[]): string {
  if (cases.length === 0) return '<p class="sub">No cases yet.</p>';
  return cases
    .map(
      (c, i) =>
        `<div class="case"><span class="cat ${CAT_CLASS[c.category]}"></span>` +
        `<div class="cx"><div class="ct">${c.category}</div><div class="cb">${esc(c.input)}</div></div>` +
        `<button class="rm" data-i="${i}" title="Remove">✕</button></div>`,
    )
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
      return (
        `<div class="mrow"><div class="cse" title="${esc(tip)}">${idTag}${esc(detail)}</div>` +
        `<div class="cell ${b === 'lo' ? 'lo' : 'ok'}">${r.score.toFixed(1)}</div>` +
        `<div class="cell">${mark}</div></div>`
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

/** One-line rubric-health summary from a validation result. */
export function rubricHealthHtml(health: {
  discrimination: { gap: number; rating: string };
  consistency: { stdDev: number; rating: string };
}): string {
  return (
    `<span class="rh-disc">Discrimination ${health.discrimination.rating} (${health.discrimination.gap.toFixed(1)})</span>` +
    ` · <span class="rh-cons">Consistency σ${health.consistency.stdDev.toFixed(1)} (${health.consistency.rating})</span>`
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
      return (
        `<div class="ver${v.delta === null ? ' base' : ''}"><div class="vh"><span class="vt">${esc(v.label)}</span>${cur}${deltaHtml}` +
        `<span class="vsc">${v.overall.toFixed(1)} · ${esc(v.passLabel)} · ${v.avgSeconds}s</span></div>` +
        `<div class="vnote">${esc(v.note)}</div></div>`
      );
    })
    .join('');
  return `<div class="vtl">${rows}</div>`;
}
