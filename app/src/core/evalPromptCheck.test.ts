import { describe, it, expect } from 'vitest';
import { checkEvalPrompt } from './evalPromptCheck';

const GOOD = `
SECTION 0: INPUT DATA
SECTION 1: ROLE & GOAL — evaluate ONLY clarity. The transcript is the definitive source of truth.
SECTION 2: DIMENSION & SUB-CRITERIA. Sub-criteria are mutually exclusive. Distinctness: this covers wording only, leaving alignment to a sibling. FAILURES TO FLAG: vague claims. Threshold: ≥2 distinct snippets.
SECTION 3: SCORING GUIDE — STRONG / ACCEPTABLE / WEAK / FAIL. Fail-safe: lowest sub-score wins.
SECTION 4: PROCEDURE — STEP 0: evidence extraction before any scoring. Evidence must be verbatim and traceable, located by field path output_parsed.short_reason. Patterns need ≥2 signals.
SECTION 5: OUTPUT FORMAT — issues with Problem, Evidence ID, Impact, Location.
SECTION 6: EXAMPLES — Example 1: STRONG …
SECTION 7: QUALITY CHECKLIST — [ ] clean scope
`;

const POOR = 'Just read the output and give it a score from 1 to 10. Use your judgment.';

describe('checkEvalPrompt', () => {
  it('should pass a production-grade rubric', () => {
    const r = checkEvalPrompt(GOOD);
    expect(r.passed).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(7.5);
    expect(r.missing).toEqual([]);
  });
  it('should fail a vague rubric and list what is missing', () => {
    const r = checkEvalPrompt(POOR);
    expect(r.passed).toBe(false);
    expect(r.missing).toContain('FAILURES TO FLAG sections');
    expect(r.missing).toContain('fail-safe scoring logic');
  });
});
