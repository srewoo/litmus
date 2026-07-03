/**
 * Controller tests for the MCP panel. jsdom cannot be loaded in this repo
 * (Node 20.17 can't require() a transitive ESM dep), so a compact parse5-backed
 * DOM shim stands in — enough for the panel's real DOM surface (innerHTML,
 * getElementById, querySelectorAll, classList, dataset, bubbling click events).
 *
 * The panel is driven through its genuine DI seams: platform storage /
 * host-permission and the MCP client + conformance runner are all mocked, and
 * handlers fire via real dispatched click events — exactly as in the browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseFragment } from 'parse5';
import type { McpCallResult, McpHandshake, McpToolDescriptor } from '../mcp/types';
import type { ConformanceReport } from '../mcp/conformance';

/* ----------------------------- DI seam mocks ----------------------------- */
const loadSettings = vi.fn();
const saveSettings = vi.fn();
const ensureHostPermission = vi.fn();
const connectMcp = vi.fn();
const runConformance = vi.fn();
const callTool = vi.fn();
const listTools = vi.fn();

vi.mock('../platform/chromeStorage', () => ({ chromeLocal: () => ({}) }));
vi.mock('../platform/storage', () => ({
  loadSettings: (...a: unknown[]) => loadSettings(...a),
  saveSettings: (...a: unknown[]) => saveSettings(...a),
}));
vi.mock('../platform/hostPermission', () => ({ ensureHostPermission: (...a: unknown[]) => ensureHostPermission(...a) }));
vi.mock('../mcp/client', () => ({ connectMcp: (...a: unknown[]) => connectMcp(...a) }));
vi.mock('../mcp/conformance', () => ({ runConformance: (...a: unknown[]) => runConformance(...a) }));
vi.mock('../mcp/security', () => ({ runSecurityScan: vi.fn() }));

/* --------------------------- minimal DOM shim ---------------------------- */
type P5Node = { tagName?: string; nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: P5Node[] };

class El {
  readonly children: El[] = [];
  parent: El | null = null;
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, ((e: FakeEvent) => void)[]>();
  private classes = new Set<string>();
  private text = '';
  private raw = '';
  value = '';
  checked = false;
  constructor(readonly tagName: string) {}

  get id(): string { return this.attrs.get('id') ?? ''; }
  setAttribute(name: string, val: string): void { this.attrs.set(name, val); if (name === 'class') this.classes = new Set(val.split(/\s+/).filter(Boolean)); }
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; }
  get innerHTML(): string { return this.raw; }
  set innerHTML(html: string) { this.raw = html; this.children.length = 0; for (const c of parseChildren(html)) { c.parent = this; this.children.push(c); } }
  get classList() {
    return {
      contains: (c: string) => this.classes.has(c),
      add: (c: string) => void this.classes.add(c),
      remove: (c: string) => void this.classes.delete(c),
      toggle: (c: string, force?: boolean) => { const on = force ?? !this.classes.has(c); on ? this.classes.add(c) : this.classes.delete(c); return on; },
    };
  }
  addEventListener(type: string, fn: (e: FakeEvent) => void): void { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
  dispatchEvent(e: FakeEvent): void { e.target = this; let n: El | null = this; while (n) { e.currentTarget = n; for (const fn of n.listeners.get(e.type) ?? []) fn(e); n = n.parent; } }
  closest(sel: string): El | null { let n: El | null = this; while (n) { if (matches(n, sel)) return n; n = n.parent; } return null; }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): El[] { return queryAll(this, sel); }
}

interface FakeEvent { type: string; target: El | null; currentTarget: El | null; preventDefault(): void; key?: string; }

function build(node: P5Node): El {
  const el = new El(node.tagName ?? node.nodeName);
  for (const a of node.attrs ?? []) {
    el.setAttribute(a.name, a.value);
    if (a.name === 'value') el.value = a.value;
    if (a.name.startsWith('data-')) el.dataset[camel(a.name.slice(5))] = a.value;
  }
  for (const c of node.childNodes ?? []) { if (c.nodeName === '#text') { el.textContent += c.value ?? ''; } else { const ch = build(c); ch.parent = el; el.children.push(ch); } }
  return el;
}
const camel = (s: string): string => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
function parseChildren(html: string): El[] {
  const frag = parseFragment(html) as unknown as P5Node;
  return (frag.childNodes ?? []).filter((n) => n.nodeName !== '#text').map(build);
}

function matches(el: El, token: string): boolean {
  if (token.startsWith('#')) return el.id === token.slice(1);
  if (token.startsWith('.')) return el.classList.contains(token.slice(1));
  const attr = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attr) { const v = el.attrs.get(attr[1]!); return attr[2] === undefined ? el.attrs.has(attr[1]!) : v === attr[2]; }
  return el.tagName.toLowerCase() === token.toLowerCase();
}
function descendants(el: El): El[] { const out: El[] = []; for (const c of el.children) { out.push(c, ...descendants(c)); } return out; }
function queryAll(root: El, sel: string): El[] {
  const parts = sel.trim().split(/\s+/);
  if (parts.length === 1) return descendants(root).filter((e) => matches(e, parts[0]!));
  const [left, right] = parts as [string, string];
  return descendants(root).filter((e) => matches(e, right) && !!e.closest(left) && e.closest(left) !== e);
}

class FakeMouseEvent implements FakeEvent {
  type = 'click'; target: El | null = null; currentTarget: El | null = null; key?: string;
  constructor(type: string, init?: { key?: string }) { this.type = type; if (init?.key) this.key = init.key; }
  preventDefault(): void {}
}

let documentRoot: El;
function installDom(): void {
  documentRoot = new El('html');
  const body = new El('body');
  body.parent = documentRoot;
  documentRoot.children.push(body);
  const doc = {
    body,
    getElementById: (id: string) => descendants(documentRoot).find((e) => e.id === id) ?? null,
    querySelector: (sel: string) => queryAll(documentRoot, sel)[0] ?? null,
    querySelectorAll: (sel: string) => queryAll(documentRoot, sel),
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  (globalThis as unknown as { MouseEvent: unknown }).MouseEvent = FakeMouseEvent;
  (globalThis as unknown as { KeyboardEvent: unknown }).KeyboardEvent = FakeMouseEvent;
}

/* ------------------------------ fixtures --------------------------------- */
import { initMcpPanel } from './mcpPanel';

const HANDSHAKE: McpHandshake = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: true, resources: false, prompts: false },
  serverInfo: { name: 'demo', version: '1.0.0' },
};
const calcTool: McpToolDescriptor = {
  name: 'calc',
  description: 'adds',
  inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
};
const okReport = (over: Partial<ConformanceReport> = {}): ConformanceReport => ({
  ok: true,
  handshake: HANDSHAKE,
  toolCount: 1,
  resourceCount: 0,
  promptCount: 0,
  findings: [{ level: 'pass', check: 'handshake', detail: 'ok' }],
  ...over,
});

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const byId = (id: string): El => (globalThis.document.getElementById(id) as unknown as El);
const click = (id: string): void => byId(id).dispatchEvent(new FakeMouseEvent('click'));

function setDom(): void {
  installDom();
  globalThis.document.body.innerHTML =
    '<button id="mcpConnectBtn"></button>' +
    '<select id="mcpTransport"></select>' +
    '<input id="mcpName" value="server" />' +
    '<input id="mcpUrl" value="https://example.com/mcp" />' +
    '<input id="mcpAuth" type="password" />' +
    '<div id="mcpBar"></div><div id="mcpConnect"></div><div id="mcpInspect"></div>' +
    '<div id="mcpStatus"></div><div id="mcpCaps"></div><div id="mcpConformance"></div>' +
    '<div id="mcpSecurity"></div><div id="mcpCatalog"></div>' +
    '<button id="mcpScanBtn"></button><button id="mcpForgetBtn"></button>' +
    '<button id="mcpUseScenarioBtn"></button><button id="mcpBackBtn"></button>';
  byId('mcpTransport').value = 'http';
}

beforeEach(() => {
  vi.clearAllMocks();
  loadSettings.mockResolvedValue({ mcpServers: [] });
  saveSettings.mockResolvedValue(undefined);
  ensureHostPermission.mockResolvedValue(true);
  callTool.mockResolvedValue({ isError: false, text: 'ok', content: [] } as McpCallResult);
  listTools.mockResolvedValue([calcTool]);
  connectMcp.mockReturnValue({ listTools, listResources: vi.fn().mockResolvedValue([]), listPrompts: vi.fn().mockResolvedValue([]), callTool });
  setDom();
});

async function connectAndSelectCalc(): Promise<void> {
  runConformance.mockResolvedValue(okReport());
  initMcpPanel();
  click('mcpConnectBtn');
  await flush();
  (globalThis.document.querySelector('.mcp-tool') as unknown as El).dispatchEvent(new FakeMouseEvent('click'));
  await flush();
}

/* -------------------------------- tests ---------------------------------- */
describe('MCP panel — number field validation (bug 1)', () => {
  it('should reject a non-numeric value in a number field client-side, without calling the tool', async () => {
    await connectAndSelectCalc();
    (globalThis.document.querySelector('[data-arg="n"]') as unknown as El).value = '1O'; // letter O, not one-zero
    click('mcpCallBtn');
    await flush();
    expect(callTool).not.toHaveBeenCalled();
    const result = byId('mcpToolResult').innerHTML;
    expect(result).toContain('mcp-err');
    expect(result).toContain('must be a number');
  });

  it('should send a valid numeric value as a real number', async () => {
    await connectAndSelectCalc();
    (globalThis.document.querySelector('[data-arg="n"]') as unknown as El).value = '5';
    click('mcpCallBtn');
    await flush();
    expect(callTool).toHaveBeenCalledWith('calc', { n: 5 });
  });
});

describe('MCP panel — persist only after handshake (bug 2)', () => {
  it('should NOT persist the config when the handshake fails', async () => {
    runConformance.mockResolvedValue(
      okReport({ ok: false, handshake: undefined, findings: [{ level: 'fail', check: 'handshake', detail: 'nope' }] }),
    );
    initMcpPanel();
    click('mcpConnectBtn');
    await flush();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(byId('mcpBar').innerHTML).toContain('nope');
    // In-memory form state survives the failure (user keeps what they typed).
    expect(byId('mcpUrl').value).toBe('https://example.com/mcp');
  });

  it('should persist the config only after a successful handshake', async () => {
    runConformance.mockResolvedValue(okReport());
    initMcpPanel();
    click('mcpConnectBtn');
    await flush();
    expect(saveSettings).toHaveBeenCalledTimes(1);
    const saved = saveSettings.mock.calls[0]![1] as { mcpServers: { url: string; name: string }[] };
    expect(saved.mcpServers[0]!.url).toBe('https://example.com/mcp');
    expect(saved.mcpServers[0]!.name).toBe('server');
  });
});
