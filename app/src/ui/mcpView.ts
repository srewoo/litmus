/**
 * Pure HTML builders for the MCP panel (connect/inspect/security). Separated from
 * the controller so they're unit-testable and all server-supplied text is escaped
 * here. Mirrors the conventions in `views.ts` (esc, small focused builders).
 */
import { esc } from './views';
import type { ConformanceReport, Finding } from '../mcp/conformance';
import type { McpHandshake, McpPrompt, McpResource, McpToolDescriptor } from '../mcp/types';
import type { SecurityReport, Severity } from '../mcp/security';

export type ConnState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Sticky connection bar: a colored dot + identity, plus a standing "live" warning. */
export function connectionBarHtml(state: ConnState, handshake?: McpHandshake, message?: string): string {
  const dot = `<span class="mcp-dot ${state}"></span>`;
  if (state === 'connected' && handshake) {
    const h = handshake;
    return (
      `<div class="mcp-bar connected">${dot}` +
      `<span class="mcp-id"><strong>${esc(h.serverInfo.name)}</strong> ${esc(h.serverInfo.version)} · ${esc(h.protocolVersion)}</span>` +
      `<span class="mcp-live">⚠ live</span>` +
      `<button class="mcp-edit" id="mcpEditBtn" type="button">edit</button></div>`
    );
  }
  const label =
    state === 'connecting' ? 'Connecting…' : state === 'error' ? esc(message ?? 'Connection failed') : 'Not connected';
  return `<div class="mcp-bar ${state}">${dot}<span class="mcp-id">${label}</span>` +
    (state === 'connecting' ? '<span class="spinner sm"></span>' : '') +
    (state === 'error' ? '<button class="mcp-edit" id="mcpEditBtn" type="button">retry</button>' : '') +
    '</div>';
}

/** Capability summary line after a successful handshake. */
export function capabilitiesHtml(report: ConformanceReport): string {
  if (!report.handshake) return '<div class="mcp-err">Not connected.</div>';
  const h = report.handshake;
  const caps = [
    h.capabilities.tools ? `tools (${report.toolCount})` : '',
    h.capabilities.resources ? `resources (${report.resourceCount})` : '',
    h.capabilities.prompts ? `prompts (${report.promptCount})` : '',
  ].filter(Boolean);
  return (
    `<div class="mcp-server"><strong>${esc(h.serverInfo.name)}</strong> ${esc(h.serverInfo.version)} ` +
    `· protocol ${esc(h.protocolVersion)}</div>` +
    `<div class="mcp-caps">${caps.length ? caps.map((c) => `<span class="mcp-chip">${esc(c)}</span>`).join('') : '<em>no capabilities advertised</em>'}</div>`
  );
}

/** Conformance findings list, worst level first. */
export function findingsHtml(findings: readonly Finding[]): string {
  const order = { fail: 0, warn: 1, pass: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  const rows = sorted
    .map((f) => `<li class="mcp-find ${f.level}"><span class="lvl">${f.level}</span> <span class="chk">${esc(f.check)}</span> ${esc(f.detail)}</li>`)
    .join('');
  return `<ul class="mcp-findings">${rows}</ul>`;
}

/** Collapsed conformance summary pill + the full findings behind a disclosure. */
export function conformancePillHtml(report: ConformanceReport): string {
  const counts = report.findings.reduce(
    (a, f) => ((a[f.level] += 1), a),
    { fail: 0, warn: 0, pass: 0 } as Record<Finding['level'], number>,
  );
  const bits = [
    counts.fail ? `${counts.fail} fail` : '',
    counts.warn ? `${counts.warn} warn` : '',
    `${counts.pass} pass`,
  ].filter(Boolean);
  const open = counts.fail > 0 ? ' open' : '';
  return (
    `<details class="mcp-disc"${open}><summary>Conformance · ${bits.join(' · ')}</summary>` +
    findingsHtml(report.findings) +
    `</details>`
  );
}

/** Tool catalog as selectable rows (Inspector-lite). */
export function toolListHtml(tools: readonly McpToolDescriptor[]): string {
  if (tools.length === 0) return '<div class="mcp-empty">No tools exposed.</div>';
  return (
    '<ul class="mcp-tools">' +
    tools
      .map(
        (t) =>
          `<li class="mcp-tool" data-tool="${esc(t.name)}"><code>${esc(t.name)}</code>` +
          (t.description ? ` — ${esc(t.description)}` : '') +
          `</li>`,
      )
      .join('') +
    '</ul>'
  );
}

type PropSpec = { type?: string; enum?: readonly unknown[]; description?: string };

/** Max inputs a single batch run accepts, and how many run concurrently. */
export const MAX_BATCH = 10;
export const BATCH_CONCURRENCY = 5;

function propsOf(tool: McpToolDescriptor): Record<string, PropSpec> {
  const p = tool.inputSchema['properties'];
  return typeof p === 'object' && p !== null ? (p as Record<string, PropSpec>) : {};
}
function requiredOf(tool: McpToolDescriptor): string[] {
  const r = tool.inputSchema['required'];
  return Array.isArray(r) ? r.filter((k): k is string => typeof k === 'string') : [];
}
function stringFieldsOf(tool: McpToolDescriptor): string[] {
  return Object.entries(propsOf(tool))
    .filter(([, s]) => (s.type ?? 'string') === 'string')
    .map(([k]) => k);
}

/** Field names that usually hold the "content" you'd want to vary across a batch. */
const CONTENT_FIELD_NAMES = ['question', 'query', 'prompt', 'input', 'text', 'message', 'content', 'q'];

/**
 * Which field a batch run varies by default. Prefers a content-like field
 * (question/query/prompt/…) so a multi-string tool like ask_question(repoName,
 * question) varies `question`, not `repoName`. Falls back to the first required
 * string, then any string. With no string parameter, each line must be JSON.
 * The user can override the field via the batch "vary field" selector.
 */
export function batchFieldFor(tool: McpToolDescriptor): { name: string; mode: 'value' | 'json' } {
  const strings = stringFieldsOf(tool);
  if (strings.length === 0) return { name: '', mode: 'json' };
  const required = requiredOf(tool);
  const byName = strings.find((k) => CONTENT_FIELD_NAMES.includes(k.toLowerCase()));
  const reqStr = strings.find((k) => required.includes(k));
  return { name: byName ?? reqStr ?? strings[0]!, mode: 'value' };
}

function fieldFor(key: string, spec: PropSpec, required: boolean): string {
  const label = `<label class="mcp-flabel">${esc(key)}${required ? '<span class="req">●</span>' : ''}</label>`;
  const da = `data-arg="${esc(key)}"`;
  if (Array.isArray(spec.enum)) {
    const opts = spec.enum.map((v) => `<option value="${esc(String(v))}">${esc(String(v))}</option>`).join('');
    return `${label}<div class="select"><span class="sl"><span class="pv">▾</span><select ${da} data-type="enum">${opts}</select></span></div>`;
  }
  const t = spec.type ?? 'string';
  if (t === 'boolean') {
    return `${label}<label class="mcp-toggle"><input type="checkbox" ${da} data-type="boolean" /> <span>true / false</span></label>`;
  }
  if (t === 'number' || t === 'integer') {
    return `${label}<input class="field mono" type="number" ${da} data-type="number" placeholder="0" />`;
  }
  if (t === 'string') {
    return `${label}<input class="field mono" ${da} data-type="string" placeholder="${esc(spec.description ?? '')}" />`;
  }
  // object / array / unmodeled → per-field raw JSON.
  return `${label}<input class="field mono" ${da} data-type="json" placeholder='JSON, e.g. {"k":1}' />`;
}

/**
 * A per-tool form generated from its JSON Schema (Inspector-style typed fields),
 * with a raw-JSON escape hatch for unmodeled shapes. Because the form IS the
 * selected tool, it structurally avoids sending one tool's args to another.
 */
export function toolFormHtml(tool: McpToolDescriptor): string {
  const props = (typeof tool.inputSchema['properties'] === 'object' && tool.inputSchema['properties'] !== null
    ? tool.inputSchema['properties']
    : {}) as Record<string, PropSpec>;
  const required = new Set(Array.isArray(tool.inputSchema['required']) ? (tool.inputSchema['required'] as string[]) : []);
  const fields = Object.entries(props)
    .map(([k, spec]) => `<div class="mcp-field">${fieldFor(k, spec, required.has(k))}</div>`)
    .join('');
  const body = fields || '<div class="mcp-empty">No declared parameters.</div>';
  const batch = batchFieldFor(tool);
  const strings = stringFieldsOf(tool);
  // A "vary field" selector only when there's a choice (>1 string field).
  const batchSelector =
    batch.mode === 'value' && strings.length > 1
      ? `<div class="dlabel">Vary field (other args come from the form above)</div>` +
        `<div class="select"><span class="sl"><span class="pv">▾</span><select id="mcpBatchField">` +
        strings.map((k) => `<option value="${esc(k)}"${k === batch.name ? ' selected' : ''}>${esc(k)}</option>`).join('') +
        `</select></span></div>`
      : '';
  const batchLabel =
    batch.mode === 'json'
      ? `One JSON args object per line · up to ${MAX_BATCH}, ${BATCH_CONCURRENCY} at a time`
      : strings.length > 1
        ? `Each line fills the chosen field; fill the other args in the form above · up to ${MAX_BATCH}, ${BATCH_CONCURRENCY} at a time`
        : `One "${esc(batch.name)}" per line · up to ${MAX_BATCH}, ${BATCH_CONCURRENCY} at a time`;
  const batchPlaceholder =
    batch.mode === 'value' ? `what is the purpose of this repo?\nwhat language is it written in?` : `{"city":"Paris"}\n{"city":"Tokyo"}`;
  return (
    `<div class="mcp-form" data-tool="${esc(tool.name)}">` +
    `<div class="mcp-formhead"><code>${esc(tool.name)}</code>` +
    `<button class="mcp-rawtoggle" id="mcpRawToggle" type="button">{ } raw</button></div>` +
    `<div class="mcp-fields" id="mcpFields">${body}</div>` +
    `<textarea class="field mono mcp-rawbox hidden" id="mcpRawBox" spellcheck="false" placeholder='{"arg":"value"}'></textarea>` +
    `<p class="varnote">⚠ Live call — real side effects on the server.</p>` +
    `<button class="btn ghost block" id="mcpCallBtn" data-tool="${esc(tool.name)}">▶ Call ${esc(tool.name)}</button>` +
    `<div id="mcpToolResult"></div>` +
    `<details class="mcp-disc mcp-batch"><summary>Batch run</summary>` +
    batchSelector +
    `<div class="dlabel">${batchLabel}</div>` +
    `<textarea class="field mono" id="mcpBatchInput" spellcheck="false" placeholder="${batchPlaceholder}"></textarea>` +
    `<button class="btn ghost block" id="mcpBatchBtn" data-tool="${esc(tool.name)}" data-field="${esc(batch.name)}" data-mode="${batch.mode}">▶ Run batch (${BATCH_CONCURRENCY} at a time)</button>` +
    `<div id="mcpBatchResult"></div>` +
    `</details>` +
    `</div>`
  );
}

/** One batch invocation's outcome, for `batchResultsHtml`. */
export interface BatchItemResult {
  readonly input: string;
  readonly ok: boolean;
  readonly text: string;
}

/** Render the results of a batch run: a count summary plus a per-input collapsible. */
export function batchResultsHtml(items: readonly BatchItemResult[]): string {
  if (items.length === 0) return '';
  const fails = items.filter((i) => !i.ok).length;
  const summary = `<div class="mcp-secsum"><span class="mcp-chip ok">${items.length - fails} ok</span>${fails ? `<span class="mcp-chip high">${fails} failed</span>` : ''}</div>`;
  const rows = items
    .map((it) => {
      const open = it.ok ? '' : ' open';
      return (
        `<details class="mcp-disc"${open}><summary class="${it.ok ? '' : 'mcp-find high'}">${it.ok ? '✓' : '✗'} ${esc(it.input.slice(0, 80))}</summary>` +
        `<div class="mcp-result ${it.ok ? 'mcp-ok' : 'mcp-err'}"><pre>${esc(it.text)}</pre></div></details>`
      );
    })
    .join('');
  return summary + rows;
}

export function resourcesHtml(resources: readonly McpResource[]): string {
  if (resources.length === 0) return '<div class="mcp-empty">No resources.</div>';
  return '<ul class="mcp-res">' + resources.map((r) => `<li><code>${esc(r.uri)}</code>${r.name ? ` — ${esc(r.name)}` : ''}</li>`).join('') + '</ul>';
}

export function promptsHtml(prompts: readonly McpPrompt[]): string {
  if (prompts.length === 0) return '<div class="mcp-empty">No prompts.</div>';
  return '<ul class="mcp-prompts">' + prompts.map((p) => `<li><code>${esc(p.name)}</code>${p.description ? ` — ${esc(p.description)}` : ''}</li>`).join('') + '</ul>';
}

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Security scan report: a counts summary plus the notable findings (leaks/accepted-invalid first). */
export function securityReportHtml(report: SecurityReport): string {
  const c = report.counts;
  const summary =
    `<div class="mcp-secsum">` +
    `<span class="mcp-chip high">${c['possible-leak']} possible leak</span>` +
    `<span class="mcp-chip med">${c['accepted-invalid']} accepted-invalid</span>` +
    `<span class="mcp-chip med">${c['server-error']} server-error</span>` +
    `<span class="mcp-chip ok">${c.rejected} rejected</span>` +
    `</div>`;
  const notable = report.findings
    .filter((f) => f.classification !== 'rejected')
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  if (notable.length === 0) {
    return summary + '<div class="mcp-ok">No issues found — every adversarial probe was rejected.</div>';
  }
  const rows = notable
    .map(
      (f) =>
        `<li class="mcp-find ${f.severity}"><span class="lvl">${f.severity}</span> <code>${esc(f.probe.toolName)}</code> ` +
        `<span class="chk">${esc(f.probe.kind)}</span> ${esc(f.detail)} <em>(${esc(f.probe.description)})</em></li>`,
    )
    .join('');
  // Auto-expand only when there's a high-severity finding; otherwise keep it tucked.
  const open = notable.some((f) => f.severity === 'high') ? ' open' : '';
  const notes = report.notes.length ? `<div class="mcp-notes">${report.notes.map((n) => esc(n)).join('<br>')}</div>` : '';
  return (
    summary +
    `<details class="mcp-disc"${open}><summary>${notable.length} notable finding(s)</summary>` +
    `<ul class="mcp-findings">${rows}</ul>${notes}</details>`
  );
}
