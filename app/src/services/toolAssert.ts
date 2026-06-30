/**
 * Deterministic tool-call assertion (ADR 0001). Given the tool calls a model
 * emitted, the case's expectation, and the run's tool catalog, decide pass/fail
 * with concrete reasons — no LLM involved, so the verdict is stable.
 *
 * The schema validation here is intentionally MINIMAL (object / required /
 * top-level property types) — enough to catch the high-frequency failures
 * (missing required arg, wrong primitive type), not a full JSON Schema engine.
 */
import type { ToolCall, ToolDef, ToolExpectation } from '../shared/types';

export interface ToolAssertResult {
  readonly passed: boolean;
  /** 0–10, folded into the case score (10 pass, 0 fail). */
  readonly score: number;
  readonly reasons: readonly string[];
}

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

function jsonTypeOf(v: unknown): JsonType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (t === 'string' || t === 'boolean' || t === 'object') return t as JsonType;
  return 'null';
}

/** integer satisfies number; everything else must match exactly. */
function typeMatches(actual: JsonType, expected: JsonType): boolean {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

/** Minimal JSON-Schema check of a tool's arguments. Returns problems (empty = ok). */
export function validateArgsSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if ((schema['type'] ?? 'object') === 'object') {
    if (jsonTypeOf(value) !== 'object') {
      return [`arguments must be an object, got ${jsonTypeOf(value)}`];
    }
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
    for (const key of required) {
      if (!(key in obj)) problems.push(`missing required argument "${key}"`);
    }
    const props = (schema['properties'] ?? {}) as Record<string, { type?: JsonType }>;
    for (const [key, spec] of Object.entries(props)) {
      if (key in obj && spec?.type && !typeMatches(jsonTypeOf(obj[key]), spec.type)) {
        problems.push(`argument "${key}" should be ${spec.type}, got ${jsonTypeOf(obj[key])}`);
      }
    }
  }
  return problems;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Check every required arg key/value is present and equal in the call's arguments. */
function checkRequiredArgs(args: unknown, required: Readonly<Record<string, unknown>>): string[] {
  if (jsonTypeOf(args) !== 'object') return ['expected arguments object for requiredArgs check'];
  const obj = args as Record<string, unknown>;
  const problems: string[] = [];
  for (const [k, v] of Object.entries(required)) {
    if (!(k in obj)) problems.push(`required argument "${k}" was not provided`);
    else if (!deepEqual(obj[k], v)) problems.push(`argument "${k}" should equal ${JSON.stringify(v)}, got ${JSON.stringify(obj[k])}`);
  }
  return problems;
}

export function assertToolCalls(
  calls: readonly ToolCall[],
  expectation: ToolExpectation,
  toolDefs: readonly ToolDef[] = [],
): ToolAssertResult {
  const reasons: string[] = [];

  // 1) Forbidden tools must not appear.
  if (expectation.forbiddenTools?.length) {
    const forbidden = new Set(expectation.forbiddenTools);
    for (const c of calls) {
      if (forbidden.has(c.name)) reasons.push(`forbidden tool "${c.name}" was called`);
    }
  }

  // The call we evaluate args against is ONLY the expected tool's call. With no
  // expectedTool there is no defined call to validate — picking calls[0] would
  // run args/schema/requiredArgs checks against an arbitrary call and produce
  // false FAILs (e.g. forbidden-only expectations where the model correctly
  // avoided the forbidden tool but called a different tool with imperfect args).
  const target = expectation.expectedTool
    ? calls.find((c) => c.name === expectation.expectedTool)
    : undefined;

  // 2) Expected tool must be called.
  if (expectation.expectedTool && !target) {
    reasons.push(`expected tool "${expectation.expectedTool}" was not called`);
  }

  if (target) {
    // 3) Arguments must have parsed as JSON.
    if (target.arguments === undefined && target.rawArguments !== undefined) {
      reasons.push(`arguments for "${target.name}" were not valid JSON`);
    } else {
      // 4) Validate against the tool's declared schema, if we have one.
      const def = toolDefs.find((d) => d.name === target.name);
      if (def) reasons.push(...validateArgsSchema(target.arguments, def.parameters));
      // 5) Required exact-match args.
      if (expectation.requiredArgs) reasons.push(...checkRequiredArgs(target.arguments, expectation.requiredArgs));
    }
  }

  const passed = reasons.length === 0;
  return { passed, score: passed ? 10 : 0, reasons };
}

/** One-line human summary for a case rationale. */
export function describeToolAssert(result: ToolAssertResult): string {
  return result.passed ? 'Tool-call expectations met.' : `Tool-call check failed: ${result.reasons.join('; ')}`;
}
