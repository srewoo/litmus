/**
 * Document (PDF/PPT) evaluator pack (ADR 0007). The most deterministically
 * checkable modality, so the LLM judge is barely needed. Hard gates: parse,
 * format, page/slide count, no leftover placeholders, no corrupt embeds. Content
 * checks (all deterministic, no judge): every requested data point present
 * VERBATIM (catches hallucinated figures — the primary document risk), section
 * headings present, minimum table count.
 */
import type { DocumentExpectation, DocumentSignals } from '../../shared/media';
import { round1 } from '../../shared/num';
import { foldChecks, type Check, type CheckResult } from './types';

function fractionPresent(haystack: string, needles: readonly string[]): { frac: number; missing: string[] } {
  if (needles.length === 0) return { frac: 1, missing: [] };
  const hay = haystack.toLowerCase();
  const missing = needles.filter((n) => !hay.includes(n.toLowerCase()));
  return { frac: (needles.length - missing.length) / needles.length, missing };
}

export function checkDocument(signals: DocumentSignals, exp: DocumentExpectation): CheckResult {
  const reasons: string[] = [];
  const checks: Check[] = [];

  // ---- Hard gates ----
  if (!signals.parsed) reasons.push('output did not parse as a valid document');
  if (exp.format !== undefined && signals.format.toLowerCase() !== exp.format.toLowerCase()) {
    reasons.push(`format ${signals.format} ≠ requested ${exp.format}`);
  }
  if (exp.pageCount !== undefined && signals.pageCount !== exp.pageCount) {
    reasons.push(`${signals.pageCount} page(s)/slide(s), requested ${exp.pageCount}`);
  }
  if (signals.hasCorruptEmbeds) reasons.push('one or more embedded images/charts are corrupt');
  if ((exp.noPlaceholders ?? true) && signals.placeholders.length > 0) {
    reasons.push(`unresolved placeholder(s): ${signals.placeholders.join(', ')}`);
  }

  // ---- Content checks ----
  if (exp.requiredData && exp.requiredData.length > 0) {
    const { frac, missing } = fractionPresent(signals.text, exp.requiredData);
    checks.push({ dimension: 'data_fidelity', score: round1(frac * 10) });
    if (missing.length > 0) reasons.push(`missing/mismatched data point(s): ${missing.join(', ')}`);
  }
  if (exp.sections && exp.sections.length > 0) {
    const { frac, missing } = fractionPresent(signals.text, exp.sections);
    checks.push({ dimension: 'section_presence', score: round1(frac * 10) });
    if (missing.length > 0) reasons.push(`missing section(s): ${missing.join(', ')}`);
  }
  if (exp.minTables !== undefined) {
    const ok = signals.tableCount >= exp.minTables;
    checks.push({ dimension: 'table_structure', score: ok ? 10 : round1((signals.tableCount / Math.max(exp.minTables, 1)) * 10) });
    if (!ok) reasons.push(`${signals.tableCount} table(s), expected ≥ ${exp.minTables}`);
  }

  return foldChecks(reasons, checks);
}
