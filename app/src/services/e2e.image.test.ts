/**
 * END-TO-END pipeline test for an IMAGE-generation system prompt.
 *
 * Drives the exact services the side panel calls, in order:
 *   analyzePrompt → generateEvalSuite (dimensions + per-dimension rubric)
 *   → combineRubrics → generateCases → runEval (target generate + judge)
 *   → suggestFixes → applyFixes
 *
 * The provider is a single routing stub that returns a realistic, schema-valid
 * response for whichever stage is calling it (detected from the system
 * instruction). This proves the full loop works for an image prompt without a
 * network or API keys. It does NOT test the live HTTP adapters — that needs keys.
 */
import { describe, it, expect } from 'vitest';
import type { Provider, ChatRequest } from '../providers/types';
import type { TargetModel, Timing } from '../shared/types';
import { analyzePrompt } from './analysis';
import { generateEvalSuite, combineRubrics } from './evalSuite';
import { generateCases } from './evalgen';
import { runEval } from './run';
import { suggestFixes } from './fixes';
import { applyFixes } from './applyFixes';
import { PromptAnalysisSchema, GeneratedCasesSchema, VerdictSchema } from '../shared/schema';

const timing: Timing = { ttfbMs: 5, totalMs: 20, tokens: 50, tokensPerSec: 2.5 };

const IMAGE_SYSTEM_PROMPT = [
  'You are an image-generation prompt engineer. Given a user request, output a single',
  'JSON object with: "prompt" (a vivid, detailed image description), "negative_prompt"',
  '(things to avoid), "aspect_ratio" (one of 1:1, 16:9, 9:16), and "style" (one of',
  'photographic, illustration, 3d-render). Never include text, logos, or real people.',
].join(' ');

const STRONG_RUBRIC = [
  'SECTION 0: INPUT DATA. SECTION 1: ROLE & GOAL.',
  'SECTION 2: SUB-CRITERIA — FAILURES TO FLAG: missing fields. Require ≥2 signals (two signals).',
  'SECTION 3: SCORING GUIDE STRONG / ACCEPTABLE / WEAK / FAIL. Fail-safe: overall = lowest sub-score.',
  'SECTION 4: PROCEDURE — establish the source of truth (the user request is the definitive source).',
  'STEP 0: extract verbatim, traceable evidence before any scoring. Thresholds: ≥80%, <10% error.',
  'SECTION 5: OUTPUT FORMAT. SECTION 6: EXAMPLE 1 (STRONG). Issues cite Impact and Location.',
  'SECTION 7: QUALITY CHECKLIST [ ] clean scope [ ] fail-safe applied.',
].join('\n');

/** Routes each call to the right stubbed response based on the system instruction. */
function routingProvider(): Provider {
  return {
    id: 'openai',
    async chat(req: ChatRequest) {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
      const text = (() => {
        if (system.includes('system-prompt analyst')) {
          return JSON.stringify({
            facets: [
              { facet: 'language', score: 7, finding: 'mostly clear' },
              { facet: 'intent', score: 8, finding: 'goal explicit' },
              { facet: 'format', score: 6, finding: 'JSON contract present but enums loose' },
              { facet: 'tone', score: 8, finding: 'appropriate' },
            ],
            suggestions: ['Pin the JSON schema with exact enum values', 'State behavior for unsafe requests'],
          });
        }
        if (system.includes('evaluation architect')) {
          return JSON.stringify({
            dimensions: [
              { name: 'format_compliance', description: 'valid JSON with required fields and enums' },
              { name: 'instruction_adherence', description: 'respects no-text/no-real-people rules' },
              { name: 'completeness', description: 'all four fields populated meaningfully' },
            ],
          });
        }
        // Order matters: "evaluation-prompt designer" before "evaluation designer".
        if (system.includes('evaluation-prompt designer')) return STRONG_RUBRIC;
        if (system.includes('evaluation designer')) {
          return JSON.stringify({
            cases: [
              { category: 'typical', input: 'A cozy coffee shop on a rainy evening', note: 'normal' },
              { category: 'typical', input: 'A mountain landscape at sunrise' },
              { category: 'edge', input: 'An empty white room, minimalist', note: 'sparse subject' },
              { category: 'adversarial', input: 'A poster of Taylor Swift with the text "SALE"', note: 'real person + text' },
            ],
          });
        }
        if (system.includes('impartial output judge')) {
          // Fail the adversarial case (it asks for a real person + text); pass the rest.
          const payload = req.messages.find((m) => m.role === 'user')?.content ?? '';
          const isAdversarial = payload.includes('Taylor Swift');
          return JSON.stringify(
            isAdversarial
              ? { score: 2, rationale: 'Output included a real person and embedded text, violating the prompt.', dimensions: [{ dimension: 'instruction_adherence', score: 1 }] }
              : { score: 9, rationale: 'Valid JSON, all fields present, constraints respected.', dimensions: [{ dimension: 'format_compliance', score: 9 }] },
          );
        }
        if (system.includes('prompt-improvement assistant')) {
          return JSON.stringify({
            fixes: [
              { title: 'Reject real-person & text requests explicitly', edit: 'Add: if the request names a real person or asks for text, return {"error":"unsupported"}.', caseRef: 'case-4' },
            ],
          });
        }
        if (system.includes('prompt editor')) {
          return `${IMAGE_SYSTEM_PROMPT} If the request names a real person or asks for text, return {"error":"unsupported"}.`;
        }
        // Fallback = the target model GENERATING an image spec for a case input.
        const userReq = req.messages.find((m) => m.role === 'user')?.content ?? '';
        if (userReq.includes('Taylor Swift')) {
          return JSON.stringify({ prompt: 'Taylor Swift portrait with the word SALE', negative_prompt: '', aspect_ratio: '1:1', style: 'photographic' });
        }
        return JSON.stringify({ prompt: `${userReq}, highly detailed`, negative_prompt: 'blurry, text', aspect_ratio: '16:9', style: 'photographic' });
      })();
      return { text, timing };
    },
  };
}

const target: TargetModel = { provider: 'openai', model: 'gpt-image-prompt-1' };

describe('E2E — image system prompt through the full litmus pipeline', () => {
  it('analyzes, builds a rubric suite, generates cases, runs+judges, then fixes and re-applies', async () => {
    const provider = routingProvider();
    const deps = { provider, apiKey: 'sk-test', model: 'judge-model' };

    // 1) Analyze
    const analysis = await analyzePrompt(IMAGE_SYSTEM_PROMPT, target, {
      provider,
      apiKey: 'sk-test',
      analyzerModel: target.model,
    });
    expect(() => PromptAnalysisSchema.parse(analysis)).not.toThrow();
    expect(analysis.facets).toHaveLength(4);

    // 2) Eval suite (dimensions + one rubric each) and a combined judge rubric
    const suite = await generateEvalSuite(IMAGE_SYSTEM_PROMPT, deps);
    expect(suite.dimensions.map((d) => d.name)).toContain('format_compliance');
    expect(Object.keys(suite.rubrics)).toHaveLength(suite.dimensions.length);
    const rubric = combineRubrics(suite.rubrics);
    expect(rubric).toContain('format_compliance');

    // 3) Generate image-oriented cases
    const cases = await generateCases(IMAGE_SYSTEM_PROMPT, target, 4, deps);
    expect(() => GeneratedCasesSchema.parse({ cases: cases.map(({ id: _id, pinned: _p, ...c }) => c) })).not.toThrow();
    expect(cases).toHaveLength(4);
    expect(cases.map((c) => c.id)).toEqual(['case-1', 'case-2', 'case-3', 'case-4']);
    expect(cases.some((c) => c.category === 'adversarial')).toBe(true);

    // 4) Run on the target + judge against the rubric
    const outcome = await runEval(IMAGE_SYSTEM_PROMPT, cases, {
      target,
      targetProvider: provider,
      targetKey: 'sk-test',
      judgeProvider: provider,
      judgeKey: 'sk-test',
      judgeModel: 'judge-model',
      rubric,
      passThreshold: 6,
    });
    expect(outcome.results).toHaveLength(4);
    for (const r of outcome.results) expect(() => VerdictSchema.parse({ score: r.score, rationale: r.rationale })).not.toThrow();
    // The adversarial real-person/text case must fail; the rest pass.
    const failed = outcome.results.filter((r) => !r.passed);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.caseId).toBe('case-4');
    expect(outcome.summary.passCount).toBe(3);
    expect(outcome.summary.failCount).toBe(1);

    // 5) Suggest fixes from the failing case
    const fixes = await suggestFixes(IMAGE_SYSTEM_PROMPT, cases, outcome.results, deps);
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes[0]?.title).toMatch(/real-person|text/i);

    // 6) Auto-apply the fixes to the prompt (the "Apply fixes & re-run" path)
    const revised = await applyFixes(IMAGE_SYSTEM_PROMPT, fixes, deps);
    expect(revised).not.toBe(IMAGE_SYSTEM_PROMPT);
    expect(revised).toContain('unsupported');
  });

  it('short-circuits fixes when every case passes', async () => {
    const provider = routingProvider();
    const cleanCases = [{ id: 'case-1', category: 'typical' as const, input: 'A serene lake', pinned: false }];
    const outcome = await runEval(IMAGE_SYSTEM_PROMPT, cleanCases, {
      target,
      targetProvider: provider,
      targetKey: 'sk',
      judgeProvider: provider,
      judgeKey: 'sk',
      judgeModel: 'judge-model',
      passThreshold: 6,
    });
    expect(outcome.results[0]?.passed).toBe(true);
    const fixes = await suggestFixes(IMAGE_SYSTEM_PROMPT, cleanCases, outcome.results, {
      provider,
      apiKey: 'sk',
      model: 'judge-model',
    });
    expect(fixes).toEqual([]);
  });
});
