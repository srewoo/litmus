/**
 * Enforcement validation for a generated eval prompt (Athena's 13-check idea,
 * condensed). Pure: scans the text for the structural markers that separate a
 * production-grade rubric from a vague one. Returns a 0–10 score + what's missing.
 */
export interface EvalPromptCheck {
  readonly score: number;
  readonly passed: boolean;
  readonly missing: string[];
}

interface Rule {
  readonly label: string;
  readonly test: RegExp;
}

const RULES: readonly Rule[] = [
  { label: 'FAILURES TO FLAG sections', test: /failures to flag/i },
  { label: 'fail-safe scoring logic', test: /fail-?safe|lowest sub-?score|any .*fail.*dimension.*fail/i },
  { label: 'evidence-extraction-first (STEP 0)', test: /evidence extraction|step 0|before any scoring|before scoring/i },
  { label: 'source of truth established', test: /source of truth|definitive source|canonical authority/i },
  { label: 'signal discipline (≥2 signals)', test: /(≥|>=|at least )\s*2 signals|two signals|multiple signals/i },
  { label: 'verbatim/traceable evidence', test: /verbatim|traceable/i },
  { label: 'quantitative thresholds', test: /≥|>=|<=|≤|\b\d{1,3}%/ },
  { label: 'audit-ready issues (impact + location)', test: /impact[\s\S]*location|location[\s\S]*impact/i },
  { label: 'scoring levels (STRONG/WEAK/FAIL)', test: /strong[\s\S]*weak[\s\S]*fail|fail[\s\S]*weak[\s\S]*strong/i },
  { label: 'worked examples', test: /example\s*1|## example|example:/i },
  { label: 'quality checklist', test: /quality checklist|\[ \]|\[x\]/i },
  { label: 'all 8 sections present', test: /section\s*7/i },
  // Quality gates that separate an A/A+ rubric from a merely well-structured one:
  {
    label: 'orthogonal sub-criteria (no duplicate conditions)',
    test: /distinctness:|mutually exclusive|non-overlapping|does not overlap|exactly one sub-?crit|MECE/i,
  },
  {
    label: 'observable/countable thresholds (not fuzzy ratios)',
    test: /(?:≥|>=|at least )\s*\d+\s*(?:distinct\s+|verbatim\s+)?(?:signals?|snippets?|occurrences?|instances?|contradictions?|citations?|justifications?|labels?)\b/i,
  },
  {
    label: 'evidence located by field path or quoted snippet',
    test: /field path|output_parsed\.|quoted (?:phrase|snippet)|exact (?:quote|phrase|snippet)/i,
  },
];

export function checkEvalPrompt(text: string): EvalPromptCheck {
  const missing: string[] = [];
  for (const rule of RULES) {
    if (!rule.test.test(text)) missing.push(rule.label);
  }
  const passedCount = RULES.length - missing.length;
  const score = Math.round((passedCount / RULES.length) * 100) / 10; // 0–10, one decimal
  return { score, passed: score >= 7.5, missing };
}
