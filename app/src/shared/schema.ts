/**
 * Zod schemas for everything that crosses a trust boundary:
 * persisted settings and provider API responses. Per CLAUDE.md, all
 * external input is validated at runtime before the typed core touches it.
 */
import { z } from 'zod';

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'google']);

/**
 * SSRF guard for user-configured MCP endpoints. Only http/https schemes are
 * allowed (http kept for now because the panel still uses optional host
 * permissions — https is strongly preferred), and the host must not resolve to
 * a private, loopback, link-local, or cloud-metadata address. This is a
 * best-effort string-level check (literal IPs and well-known names); DNS
 * rebinding is out of scope for a client-side validator.
 */
export function isSafeHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Hostname is lower-cased by URL; strip IPv6 brackets if present.
  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (host === '') return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;

  // IPv4 literal (e.g. 169.254.169.254, 10.x, 127.x, 192.168.x, 172.16-31.x).
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((o) => Number(o));
    if (octets.some((o) => o > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    if (a === 0) return false; // 0.0.0.0/8 incl. 0.0.0.0
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    return true;
  }

  // IPv6 literal: loopback (::1), unspecified (::), ULA fc00::/7, link-local fe80::/10.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return false;
    const first = host.split(':')[0] ?? '';
    if (/^f[cd]/.test(first)) return false; // fc00::/7 (fc, fd)
    if (/^fe[89ab]/.test(first)) return false; // fe80::/10
    return true;
  }

  return true;
}

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

/** A user-configured MCP server (ADR 0003). authHeader is a secret — local only. */
export const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z
    .string()
    .url()
    .refine(isSafeHttpUrl, {
      message: 'url must be http(s) and must not target a private, loopback, link-local, or metadata host',
    }),
  transport: z.enum(['http', 'sse']).default('http'),
  authHeader: z.string().min(1).optional(),
});

export const SettingsSchema = z.object({
  /** Provider keys live only in chrome.storage.local; see PRD §13. */
  keys: KeysSchema,
  /** Configured MCP servers (ADR 0003). Stored locally; auth headers are secrets. */
  mcpServers: z.array(McpServerConfigSchema).default([]),
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
  /** Run each case this many times to measure run-to-run variance. */
  samples: z.number().int().min(1).max(5).default(1),
  /** Judge each quality output this many times and fold to the median (cuts judge noise). */
  judgeSamples: z.number().int().min(1).max(5).default(1),
  /** How many eval cases to run at once (1 = sequential). */
  concurrency: z.number().int().min(1).max(8).default(1),
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

/* ---- Tools (ADR 0001) ---- */

export const ToolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** JSON Schema object describing the tool's parameters. */
  parameters: z.record(z.unknown()),
});

export const ToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.unknown(),
  rawArguments: z.string().optional(),
});

export const ToolExpectationSchema = z.object({
  expectedTool: z.string().min(1).optional(),
  forbiddenTools: z.array(z.string().min(1)).optional(),
  requiredArgs: z.record(z.unknown()).optional(),
});

/** Model output when auto-generating tool-test cases from a catalog (ADR 0001). */
export const GeneratedToolCaseSchema = z.object({
  category: CaseCategorySchema,
  input: z.string().min(1),
  expectedTool: z.string().optional(),
  forbiddenTools: z.array(z.string()).optional(),
  requiredArgs: z.record(z.unknown()).optional(),
  note: z.string().optional(),
});

export const GeneratedToolCasesSchema = z.object({
  cases: z.array(GeneratedToolCaseSchema).min(1),
});

/* ---- Agent scenarios (ADR 0002) ---- */

export const MockResultSchema = z.union([
  z.object({ value: z.unknown() }),
  z.object({ error: z.string() }),
]);

export const MockToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.unknown()),
  results: z.array(MockResultSchema),
});

export const ScenarioSchema = z.object({
  goal: z.string().min(1),
  tools: z.array(MockToolSchema).default([]),
  maxSteps: z.number().int().min(1).max(20),
  successContains: z.array(z.string()).optional(),
  /** Run against this configured MCP server instead of mock tools (ADR 0003). */
  mcpServerId: z.string().min(1).optional(),
});

/* ---- Prompt builder turns (model output) ---- */

export const PromptBuilderTurnSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    message: z.string().min(1),
    suggestions: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal('prompt'),
    systemPrompt: z.string().min(1),
    summary: z.string().default(''),
  }),
]);
