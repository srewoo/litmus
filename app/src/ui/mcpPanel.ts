/**
 * MCP mode controller (ADR 0003). Drives the full-screen MCP view: a staged
 * flow — connect (stage 1) → inspect & test (stage 2) — with a sticky connection
 * state machine, an Inspector-style schema form per tool (no shared args box),
 * and a deliberate security scan. Calls hit a LIVE server with real side effects,
 * so the connection bar carries a standing "live" warning and the first scan
 * asks for confirmation. Render logic is in `mcpView.ts` (pure + tested).
 */
import { loadSettings, saveSettings } from '../platform/storage';
import { chromeLocal } from '../platform/chromeStorage';
import { ensureHostPermission } from '../platform/hostPermission';
import { connectMcp } from '../mcp/client';
import { runConformance } from '../mcp/conformance';
import { runSecurityScan } from '../mcp/security';
import type { McpClient } from '../mcp/client';
import type { McpHandshake, McpPrompt, McpResource, McpServerConfig, McpToolDescriptor } from '../mcp/types';
import { McpServerConfigSchema } from '../shared/schema';
import { mapWithConcurrency } from '../shared/concurrency';
import type { BatchItemResult, ConnState } from './mcpView';
import {
  batchResultsHtml,
  BATCH_CONCURRENCY,
  capabilitiesHtml,
  conformancePillHtml,
  connectionBarHtml,
  MAX_BATCH,
  promptsHtml,
  resourcesHtml,
  securityReportHtml,
  toolFormHtml,
  toolListHtml,
} from './mcpView';

const area = chromeLocal();

interface State {
  conn: ConnState;
  client?: McpClient;
  handshake?: McpHandshake;
  tools: McpToolDescriptor[];
  resources: McpResource[];
  prompts: McpPrompt[];
  cat: 'tools' | 'resources' | 'prompts';
  scanned: boolean;
  /** Id of the connected server (saved into settings.mcpServers), for the scenario on-ramp. */
  serverId?: string;
}
const s: State = { conn: 'disconnected', tools: [], resources: [], prompts: [], cat: 'tools', scanned: false };
let onBack: () => void = () => {};
let onUseInScenario: (serverId: string, toolNames: string[]) => void = () => {};

const $ = (id: string): HTMLElement | null => document.getElementById(id);
const v = (id: string): string => ($(id) as HTMLInputElement | null)?.value.trim() ?? '';
const setHtml = (id: string, html: string): void => {
  const e = $(id);
  if (e) e.innerHTML = html;
};
const status = (msg: string, kind: 'info' | 'error' = 'info'): void => {
  const e = $('mcpStatus');
  if (e) {
    e.textContent = msg;
    e.dataset['kind'] = kind;
  }
};

function setConn(conn: ConnState, message?: string): void {
  s.conn = conn;
  setHtml('mcpBar', connectionBarHtml(conn, s.handshake, message));
  $('mcpEditBtn')?.addEventListener('click', () => toStage1());
  const connected = conn === 'connected';
  $('mcpConnect')?.classList.toggle('hidden', connected);
  $('mcpInspect')?.classList.toggle('hidden', !connected);
}

function toStage1(): void {
  s.client = undefined;
  s.handshake = undefined;
  setConn('disconnected');
  status('');
}

function readConfig(): McpServerConfig {
  const transport = (($('mcpTransport') as HTMLSelectElement | null)?.value ?? 'http') as 'http' | 'sse';
  const authHeader = v('mcpAuth');
  return McpServerConfigSchema.parse({
    id: 's1',
    name: v('mcpName') || 'server',
    url: v('mcpUrl'),
    transport,
    ...(authHeader ? { authHeader } : {}),
  });
}

async function onConnect(): Promise<void> {
  let config: McpServerConfig;
  try {
    config = readConfig();
  } catch {
    status('Enter a valid server URL first.', 'error');
    return;
  }
  if (!(await ensureHostPermission(config.url))) {
    setConn('error', 'Host permission denied');
    return;
  }
  setConn('connecting');
  try {
    const client = connectMcp(config);
    const report = await runConformance(client);
    // A failed handshake comes back as a report with no handshake — that's an
    // error, not a connection. Surface it and keep the connect form available.
    if (!report.handshake) {
      const fail = report.findings.find((f) => f.level === 'fail');
      setConn('error', fail?.detail ?? 'handshake failed');
      return;
    }
    // Persist only AFTER the handshake is confirmed, so a bad/unreachable server
    // or a mistyped auth token is never written to storage. The form inputs stay
    // untouched, so on failure the user keeps whatever they typed.
    const settings = await loadSettings(area);
    await saveSettings(area, { ...settings, mcpServers: [config] });
    s.serverId = config.id;
    const caps = report.handshake.capabilities;
    s.client = client;
    s.handshake = report.handshake;
    s.tools = caps?.tools ? await client.listTools() : [];
    s.resources = caps?.resources ? await client.listResources() : [];
    s.prompts = caps?.prompts ? await client.listPrompts() : [];
    s.scanned = false;
    setConn('connected');
    setHtml('mcpCaps', capabilitiesHtml(report));
    setHtml('mcpConformance', conformancePillHtml(report));
    setHtml('mcpSecurity', '');
    s.cat = 'tools';
    renderTabs();
    renderCatalog();
    status(report.ok ? 'Connected — conformance passed.' : 'Connected, with conformance findings.');
  } catch (err) {
    // Clear stale data so a failed reconnect never shows the previous server.
    s.tools = [];
    s.resources = [];
    s.prompts = [];
    setConn('error', err instanceof Error ? err.message : String(err));
  }
}

function renderTabs(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('.mcptab'))) {
    const selected = btn.dataset['cat'] === s.cat;
    btn.setAttribute('aria-selected', String(selected));
    // Roving tabindex: only the active tab is a tab-stop (ARIA tab pattern).
    btn.setAttribute('tabindex', selected ? '0' : '-1');
  }
}

function renderCatalog(): void {
  if (s.cat === 'resources') return setHtml('mcpCatalog', resourcesHtml(s.resources));
  if (s.cat === 'prompts') return setHtml('mcpCatalog', promptsHtml(s.prompts));
  setHtml('mcpCatalog', toolListHtml(s.tools));
}

function selectTool(name: string): void {
  const tool = s.tools.find((t) => t.name === name);
  if (!tool) return;
  setHtml('mcpCatalog', toolFormHtml(tool));
  $('mcpRawToggle')?.addEventListener('click', () => {
    $('mcpFields')?.classList.toggle('hidden');
    $('mcpRawBox')?.classList.toggle('hidden');
  });
  $('mcpCallBtn')?.addEventListener('click', () => void onCall(name));
  $('mcpBatchBtn')?.addEventListener('click', (e) => void onBatch(name, e.currentTarget as HTMLElement));
}

/**
 * Build the args object for one batch line. A line that is a JSON object is used
 * as the full args (power-user override); otherwise the line fills the chosen
 * `field` and the rest of the args come from the form above (e.g. repoName).
 */
function batchArgs(line: string, field: string, mode: string): unknown {
  if (mode === 'json' || line.startsWith('{')) return JSON.parse(line);
  let base: Record<string, unknown> = {};
  try {
    const read = readArgs();
    if (read && typeof read === 'object') base = read as Record<string, unknown>;
  } catch {
    base = {};
  }
  return { ...base, [field]: line };
}

/** Run the tool once per input line, up to MAX_BATCH, BATCH_CONCURRENCY at a time. */
async function onBatch(name: string, btn: HTMLElement): Promise<void> {
  if (!s.client) return;
  const raw = ($('mcpBatchInput') as HTMLTextAreaElement | null)?.value ?? '';
  let lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    setHtml('mcpBatchResult', '<div class="mcp-err">Enter at least one line.</div>');
    return;
  }
  let truncated = false;
  if (lines.length > MAX_BATCH) {
    lines = lines.slice(0, MAX_BATCH);
    truncated = true;
  }
  // The user may override which field to vary via the selector.
  const field = ($('mcpBatchField') as HTMLSelectElement | null)?.value || btn.dataset['field'] || '';
  const mode = btn.dataset['mode'] ?? 'value';
  setHtml('mcpBatchResult', `Running ${lines.length} call(s), ${BATCH_CONCURRENCY} at a time…`);
  const client = s.client;
  const results = await mapWithConcurrency(lines, BATCH_CONCURRENCY, async (line): Promise<BatchItemResult> => {
    let args: unknown;
    try {
      args = batchArgs(line, field, mode);
    } catch {
      return { input: line, ok: false, text: 'invalid JSON for this line' };
    }
    try {
      const res = await client.callTool(name, args);
      return { input: line, ok: !res.isError, text: res.text || JSON.stringify(res.content) };
    } catch (err) {
      return { input: line, ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  });
  setHtml('mcpBatchResult', batchResultsHtml(results));
  status(truncated ? `Ran ${lines.length} (capped at ${MAX_BATCH}).` : `Ran ${lines.length} call(s).`);
}

/** A client-side validation failure (e.g. a non-numeric value in a number field). */
class ArgError extends Error {}

/** Read the schema-form fields (or the raw-JSON box) into a tool-call argument object. */
function readArgs(): unknown {
  const raw = $('mcpRawBox');
  if (raw && !raw.classList.contains('hidden')) {
    const text = (raw as HTMLTextAreaElement).value.trim();
    return text ? JSON.parse(text) : {};
  }
  const args: Record<string, unknown> = {};
  for (const f of Array.from(document.querySelectorAll<HTMLElement>('#mcpFields [data-arg]'))) {
    const key = f.dataset['arg'];
    const type = f.dataset['type'];
    if (!key) continue;
    if (type === 'boolean') {
      args[key] = (f as HTMLInputElement).checked;
      continue;
    }
    const raw = (f as HTMLInputElement | HTMLSelectElement).value.trim();
    if (raw === '') continue;
    if (type === 'number') {
      // A typo like "1O" (letter O) → NaN, which JSON.stringify silently sends
      // as null. Reject it client-side so the field never masquerades as a number.
      const num = Number(raw);
      if (Number.isNaN(num)) throw new ArgError(`"${key}" must be a number (got "${raw}").`);
      args[key] = num;
    } else if (type === 'json') args[key] = JSON.parse(raw);
    else args[key] = raw;
  }
  return args;
}

async function onCall(name: string): Promise<void> {
  if (!s.client) return;
  let args: unknown;
  try {
    args = readArgs();
  } catch (err) {
    const msg = err instanceof ArgError ? err.message : 'Arguments are not valid JSON.';
    setHtml('mcpToolResult', `<div class="mcp-err">${escapePre(msg)}</div>`);
    return;
  }
  setHtml('mcpToolResult', `Calling <code>${escapePre(name)}</code>…`);
  try {
    const res = await s.client.callTool(name, args);
    const cls = res.isError ? 'mcp-err' : 'mcp-ok';
    setHtml('mcpToolResult', `<div class="${cls} mcp-result"><pre>${escapePre(res.text || JSON.stringify(res.content, null, 2))}</pre></div>`);
  } catch (err) {
    setHtml('mcpToolResult', `<div class="mcp-err mcp-result"><pre>${escapePre(err instanceof Error ? err.message : String(err))}</pre></div>`);
  }
}

async function onScan(): Promise<void> {
  if (!s.client) {
    status('Connect to a server first.', 'error');
    return;
  }
  if (!s.scanned && !confirm(`Run the security scan? This sends many adversarial calls to ${s.tools.length} live tool(s) — real side effects.`)) {
    return;
  }
  s.scanned = true;
  status(`Running security scan over ${s.tools.length} tool(s)…`);
  try {
    const report = await runSecurityScan(s.client, s.tools);
    setHtml('mcpSecurity', securityReportHtml(report));
    status('Security scan complete.');
  } catch (err) {
    status(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

function escapePre(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Clear the saved server config and reset the form to empty. */
async function onForget(): Promise<void> {
  const settings = await loadSettings(area);
  await saveSettings(area, { ...settings, mcpServers: [] });
  for (const id of ['mcpName', 'mcpUrl', 'mcpAuth']) {
    const e = $(id) as HTMLInputElement | null;
    if (e) e.value = '';
  }
  const t = $('mcpTransport') as HTMLSelectElement | null;
  if (t) t.value = 'http';
  toStage1();
  status('Saved server forgotten.');
}

async function restore(): Promise<void> {
  const saved = (await loadSettings(area)).mcpServers?.[0];
  if (!saved) return;
  const set = (id: string, val: string): void => {
    const e = $(id) as HTMLInputElement | HTMLSelectElement | null;
    if (e) e.value = val;
  };
  set('mcpName', saved.name);
  set('mcpUrl', saved.url);
  set('mcpTransport', saved.transport);
  if (saved.authHeader) set('mcpAuth', saved.authHeader);
}

/** Wire the MCP view. `onBack` returns to the entry screen. No-op if markup absent. */
export function initMcpPanel(
  nav: { onBack: () => void; onUseInScenario?: (serverId: string, toolNames: string[]) => void } = { onBack: () => {} },
): void {
  if (!$('mcpConnectBtn')) return;
  onBack = nav.onBack;
  if (nav.onUseInScenario) onUseInScenario = nav.onUseInScenario;
  setConn('disconnected');
  $('mcpConnectBtn')?.addEventListener('click', () => void onConnect());
  $('mcpScanBtn')?.addEventListener('click', () => void onScan());
  $('mcpForgetBtn')?.addEventListener('click', () => void onForget());
  // On-ramp: turn the inspector into a test setup — prefill an agent scenario
  // bound to this live server (ADR 0003 mcpServerId) instead of dead-ending.
  $('mcpUseScenarioBtn')?.addEventListener('click', () =>
    onUseInScenario(s.serverId ?? 's1', s.tools.map((t) => t.name)),
  );
  $('mcpBackBtn')?.addEventListener('click', () => onBack());
  $('mcpCatalog')?.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('.mcp-tool') as HTMLElement | null;
    if (li?.dataset['tool']) selectTool(li.dataset['tool']);
  });
  const tabBtns = Array.from(document.querySelectorAll<HTMLElement>('.mcptab'));
  tabBtns.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      s.cat = (btn.dataset['cat'] as State['cat']) ?? 'tools';
      renderTabs();
      renderCatalog();
    });
    // Roving arrow-key navigation across the tablist (ARIA tab pattern).
    btn.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      ev.preventDefault();
      const dir = ev.key === 'ArrowRight' ? 1 : -1;
      const next = tabBtns[(i + dir + tabBtns.length) % tabBtns.length];
      next?.click();
      next?.focus();
    });
  });
  void restore();
}
