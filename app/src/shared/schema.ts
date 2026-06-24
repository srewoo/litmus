/**
 * Zod schemas for everything that crosses a trust boundary:
 * persisted settings and provider API responses. Per CLAUDE.md, all
 * external input is validated at runtime before the typed core touches it.
 */
import { z } from 'zod';

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'google']);

export const TargetModelSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
});

export const KeysSchema = z
  .object({
    openai: z.string().min(1).optional(),
    anthropic: z.string().min(1).optional(),
    google: z.string().min(1).optional(),
  })
  .default({});

export const SettingsSchema = z.object({
  /** Provider keys live only in chrome.storage.local; see PRD §13. */
  keys: KeysSchema,
  defaultTarget: TargetModelSchema.optional(),
  /** Optional judge-model override; when unset, the judge uses the target model. */
  judgeModel: z.string().min(1).optional(),
  /** Optional custom "provider/model" id for models not in the catalog. */
  customModel: z.string().min(1).optional(),
  /** Models discovered from each key via the provider's models endpoint. */
  availableModels: z
    .object({
      openai: z.array(z.string()).optional(),
      anthropic: z.array(z.string()).optional(),
      google: z.array(z.string()).optional(),
    })
    .optional(),
  /** Score at or above which a case passes (0–10). */
  passThreshold: z.number().min(0).max(10).default(6),
  /** Hard per-run spend cap, USD. */
  spendCapUsd: z.number().min(0).default(0.5),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Subset of an OpenAI chat-completion `usage` block that litmus relies on. */
export const OpenAIUsageSchema = z
  .object({
    prompt_tokens: z.number().nonnegative(),
    completion_tokens: z.number().nonnegative(),
    total_tokens: z.number().nonnegative(),
  })
  .partial();

export type OpenAIUsage = z.infer<typeof OpenAIUsageSchema>;

/** Parse unknown persisted settings, applying defaults. Throws on malformed shape. */
export function parseSettings(input: unknown): Settings {
  return SettingsSchema.parse(input ?? {});
}

/* ---- Prompt analysis (model output, validated before the core trusts it) ---- */

export const AnalysisFacetSchema = z.enum(['language', 'intent', 'format', 'tone']);

export const FacetScoreSchema = z.object({
  facet: AnalysisFacetSchema,
  score: z.number().min(0).max(10),
  finding: z.string(),
});

export const PromptAnalysisSchema = z.object({
  facets: z.array(FacetScoreSchema).min(1),
  suggestions: z.array(z.string()),
});

/* ---- Dimension extraction (model output) ---- */

export const DimensionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});

export const DimensionsSchema = z.object({
  dimensions: z.array(DimensionSchema).min(1).max(8),
});

/* ---- Coverage matrix (model output) ---- */

export const CoverageRowSchema = z.object({
  instruction: z.string().min(1),
  /** Dimension that tests this instruction, or null if NOT TESTED. */
  dimension: z.string().nullable(),
});

export const CoverageSchema = z.object({
  coverage: z.array(CoverageRowSchema),
});

/* ---- Eval-case generation (model output) ---- */

export const CaseCategorySchema = z.enum(['typical', 'edge', 'adversarial']);

export const GeneratedCaseSchema = z.object({
  category: CaseCategorySchema,
  input: z.string().min(1),
  note: z.string().optional(),
});

export const GeneratedCasesSchema = z.object({
  cases: z.array(GeneratedCaseSchema).min(1),
});

/* ---- Judge verdict (model output) ---- */

export const DimensionScoreSchema = z.object({
  dimension: z.string(),
  score: z.number().min(0).max(10),
});

export const VerdictSchema = z.object({
  score: z.number().min(0).max(10),
  rationale: z.string(),
  dimensions: z.array(DimensionScoreSchema).optional(),
});

/* ---- Fix suggestions (model output) ---- */

export const FixSchema = z.object({
  title: z.string(),
  edit: z.string(),
  /** Which case exposed this weakness, if any. */
  caseRef: z.string().optional(),
});

export const FixesSchema = z.object({
  fixes: z.array(FixSchema),
});
