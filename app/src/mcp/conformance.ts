/**
 * Layer-1 conformance & capability inspection. Connects, inspects the negotiated
 * handshake, lists every advertised capability, and validates each tool's input
 * schema is a usable JSON Schema object. Produces a flat findings report
 * (pass / warn / fail) — litmus's in-app equivalent of an Inspector sweep.
 *
 * Pure schema checks (`checkToolSchema`) are separated from the networked
 * orchestration (`runConformance`) so the rules are unit-testable in isolation.
 */
import type { McpClient } from './client';
import { CLIENT_PROTOCOL_VERSION } from './client';
import type { McpHandshake, McpToolDescriptor } from './types';

export type FindingLevel = 'pass' | 'warn' | 'fail';

export interface Finding {
  readonly level: FindingLevel;
  readonly check: string;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly ok: boolean;
  readonly handshake?: McpHandshake;
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly findings: readonly Finding[];
}

/** Validate one tool's `inputSchema` is a usable JSON Schema object. */
export function checkToolSchema(tool: McpToolDescriptor): Finding[] {
  const out: Finding[] = [];
  const s = tool.inputSchema;
  const type = s['type'];
  if (type !== undefined && type !== 'object') {
    out.push({ level: 'warn', check: `tool:${tool.name}`, detail: `inputSchema.type is "${String(type)}", expected "object"` });
  }
  const hasProps = typeof s['properties'] === 'object' && s['properties'] !== null;
  const required = s['required'];
  if (Array.isArray(required)) {
    const props = (hasProps ? (s['properties'] as Record<string, unknown>) : {}) as Record<string, unknown>;
    for (const key of required) {
      if (typeof key === 'string' && hasProps && !(key in props)) {
        out.push({ level: 'warn', check: `tool:${tool.name}`, detail: `required "${key}" is not defined in properties` });
      }
    }
  }
  if (!tool.description) {
    out.push({ level: 'warn', check: `tool:${tool.name}`, detail: 'tool has no description (hurts model tool selection)' });
  }
  if (out.length === 0) out.push({ level: 'pass', check: `tool:${tool.name}`, detail: 'schema looks well-formed' });
  return out;
}

/** Connect to a server and run the full conformance sweep. */
export async function runConformance(client: McpClient): Promise<ConformanceReport> {
  const findings: Finding[] = [];
  let handshake: McpHandshake | undefined;
  try {
    handshake = await client.connect();
  } catch (err) {
    findings.push({ level: 'fail', check: 'handshake', detail: `initialize failed: ${msg(err)}` });
    return { ok: false, toolCount: 0, resourceCount: 0, promptCount: 0, findings };
  }

  findings.push({ level: 'pass', check: 'handshake', detail: `connected to ${handshake.serverInfo.name} ${handshake.serverInfo.version}` });
  findings.push(versionFinding(handshake.protocolVersion));

  const { count: toolCount, items: tools } = await listSafely(findings, 'tools', handshake.capabilities.tools, () => client.listTools());
  for (const t of tools ?? []) findings.push(...checkToolSchema(t));

  const { count: resourceCount } = await listSafely(findings, 'resources', handshake.capabilities.resources, () => client.listResources());
  const { count: promptCount } = await listSafely(findings, 'prompts', handshake.capabilities.prompts, () => client.listPrompts());

  const ok = !findings.some((f) => f.level === 'fail');
  return { ok, handshake, toolCount, resourceCount, promptCount, findings };
}

function versionFinding(serverVersion: string): Finding {
  if (serverVersion === CLIENT_PROTOCOL_VERSION) {
    return { level: 'pass', check: 'version', detail: `protocol ${serverVersion} matches client` };
  }
  return { level: 'warn', check: 'version', detail: `server negotiated ${serverVersion}; client requested ${CLIENT_PROTOCOL_VERSION}` };
}

/** List a capability defensively: advertised-but-failing is a fail; present-but-unadvertised is a warn. */
async function listSafely<T>(
  findings: Finding[],
  name: string,
  advertised: boolean,
  list: () => Promise<readonly T[]>,
): Promise<{ count: number; items?: readonly T[] }> {
  try {
    const items = await list();
    if (!advertised && items.length > 0) {
      findings.push({ level: 'warn', check: name, detail: `${items.length} ${name} returned though capability was not advertised` });
    } else {
      findings.push({ level: 'pass', check: name, detail: `${items.length} ${name} listed` });
    }
    return { count: items.length, items };
  } catch (err) {
    if (advertised) {
      findings.push({ level: 'fail', check: name, detail: `${name} advertised but ${name}/list failed: ${msg(err)}` });
    }
    return { count: 0 };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
