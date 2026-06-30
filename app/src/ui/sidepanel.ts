/**
 * litmus side panel controller. Thin glue: holds step state, wires buttons, and
 * calls the unit-tested core/services. All HTML generation lives in views.ts; all
 * logic lives in the tested modules. Each Run saves a new version (the loop's spine).
 */
import { loadSettings, setKey, saveSettings, deleteAllKeys } from '../platform/storage';
import { chromeLocal, chromeSession } from '../platform/chromeStorage';
import { loadSnapshot, saveSnapshot } from '../platform/sessionCache';
import { mergeSettings } from './settingsForm';
import { SessionTabStore, versionKeyForTab } from '../platform/sessionTabStore';
import { getProvider } from '../providers';
import { fetchModels } from '../providers/listModels';
import type { ProviderId } from '../shared/types';
import { parseTarget } from './target';
import { buildWiring } from './providerDeps';
import { analyzePrompt } from '../services/analysis';
import { builderTurn } from '../services/promptBuilder';
import { generateCases } from '../services/evalgen';
import { generateToolCases } from '../services/toolGen';
import { generateEvalPrompt } from '../services/evalPrompt';
import { generateEvalSuite, combineRubrics } from '../services/evalSuite';
import type { Dimension } from '../services/dimensionExtract';
import { checkEvalPrompt } from '../core/evalPromptCheck';
import type { RubricHealth } from '../core/rubric';
import { validateRubric } from '../services/rubricValidation';
import { analyzeCoverage } from '../services/coverage';
import { runEval } from '../services/run';
import { suggestFixes } from '../services/fixes';
import type { Fix } from '../services/fixes';
import { applyFixes } from '../services/applyFixes';
import type { RunOutcome } from '../services/run';
import { estimateRun, exceedsCap, formatUsd } from '../core/cost';
import { aggregateDimensions } from '../core/dimensions';
import { buildAxis, describeComparison } from '../core/litmusAxis';
import { buildMarkdownReport, buildJsonReport } from '../core/report';
import type { ReportEntry } from '../core/report';
import type { RunRecord } from '../platform/store';
import { round1 } from '../shared/num';
import { MODEL_CATALOG, PROVIDER_LABEL, PROVIDER_ORDER, DEFAULT_TARGET_VALUE } from '../core/models';
import type { Settings } from '../shared/schema';
import { describeError } from './errors';
import {
  facetRowsHtml,
  casesListHtml,
  speedStripHtml,
  resultsTableHtml,
  fixesListHtml,
  versionsTimelineHtml,
  axisRowsHtml,
  axisHeaderHtml,
  coverageHtml,
  rubricHealthHtml,
  builderLogHtml,
  band,
} from './views';
import type { VersionVM, BuilderTurnVM } from './views';
import { initMcpPanel } from './mcpPanel';
import type { ChatMessage } from '../providers/types';
import type { EvalCase, PromptAnalysis, PromptBuilderTurn, PromptVersion, TargetModel, ToolDef, ToolExpectation } from '../shared/types';
import { ToolDefSchema, ScenarioSchema } from '../shared/schema';
import { z } from 'zod';

const STEPS = ['capture', 'analyze', 'evalprompt', 'cases', 'run', 'results', 'fixes', 'versions'] as const;

/** All switchable views. `generate` (prompt builder) and `mcp` (MCP mode) are off-pipeline. */
const VIEWS = [...STEPS, 'generate', 'mcp'] as const;
type View = (typeof VIEWS)[number];

/** How many cases the first generation produces, and how many "+more" adds per click. */
const DEFAULT_CASE_COUNT = 12;
const MORE_CASE_COUNT = 10;
const TOOL_CASE_COUNT = 6;

const area = chromeLocal();
const session = chromeSession();

/**
 * Resolve the session-storage key for THIS panel's tab. The per-tab side panel
 * shows the active tab, so the active tab at resolve time is the panel's tab;
 * SessionTabStore memoizes the result so every op in this session uses one key
 * even if the active tab later changes. Falls back to a stable key off-browser
 * (e.g. tests) where chrome.tabs is unavailable.
 */
async function resolveVersionKey(): Promise<string> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return versionKeyForTab(tabs[0]?.id);
  } catch {
    return versionKeyForTab(undefined);
  }
}

// Version history is per-tab and lives in chrome.storage.session: empty for a
// tab that hasn't run anything, and cleared when the tab closes (background.js).
const store = new SessionTabStore(session, resolveVersionKey);

interface AppState {
  prompt: string;
  target: TargetModel;
  analysis: PromptAnalysis | null;
  dimensions: Dimension[];
  rubrics: Record<string, string>;
  activeDimension: string;
  /** What the user is testing: prompt output quality, or tool/agent behavior. */
  mode: 'quality' | 'tools';
  /** Selected output-type pack. Only 'text' is live today; image/voice/video are roadmap. */
  outputType: 'text' | 'image' | 'voice' | 'video';
  cases: EvalCase[];
  /** Tool catalog (ADR 0001) sent to the target for tool-test cases. */
  tools: ToolDef[];
  outcome: RunOutcome | null;
  rubricHealth: RubricHealth | null;
  fixes: Fix[];
  lastVersionId: string | null;
}

const state: AppState = {
  prompt: '',
  target: parseTarget(DEFAULT_TARGET_VALUE),
  analysis: null,
  dimensions: [],
  rubrics: {},
  activeDimension: '',
  mode: 'quality',
  outputType: 'text',
  cases: [],
  tools: [],
  outcome: null,
  rubricHealth: null,
  fixes: [],
  lastVersionId: null,
};

// Session cache markers. The eval-prompt suite and generated cases are expensive
// (many LLM calls), so we keep them for the session and only regenerate when the
// inputs that shaped them change. The key is the prompt + the models in play;
// when the prompt is edited (e.g. after applying fixes) the key changes and the
// artifacts are rebuilt — which also fixes stale reuse across prompt edits.
let suiteKey: string | null = null;
let casesKey: string | null = null;

function sessionKey(ctx: Awaited<ReturnType<typeof wiring>>): string {
  return [ctx.target.model, ctx.w.auxModel, state.prompt].join('␟');
}

/**
 * Persist the regenerable artifacts (analysis, rubrics, cases) + their reuse keys
 * to chrome.storage.session, so reopening the side panel within the same browser
 * session reuses them instead of re-calling the model. Fire-and-forget.
 */
function persistSession(): void {
  void saveSnapshot(session, {
    prompt: state.prompt,
    targetValue: (el('target') as HTMLSelectElement).value,
    analysis: state.analysis,
    dimensions: state.dimensions,
    rubrics: state.rubrics,
    activeDimension: state.activeDimension,
    mode: state.mode,
    cases: state.cases,
    tools: state.tools,
    suiteKey,
    casesKey,
  });
}

/** Rehydrate state from a session snapshot. Runs after the target select is filled. */
async function restoreSession(): Promise<void> {
  const snap = await loadSnapshot(session);
  if (!snap || !snap.prompt) return;
  state.prompt = snap.prompt;
  state.analysis = snap.analysis;
  state.dimensions = snap.dimensions;
  state.rubrics = snap.rubrics;
  state.activeDimension = snap.activeDimension;
  state.cases = snap.cases;
  state.tools = snap.tools ?? [];
  if (snap.mode) setMode(snap.mode);
  applyOutputType();
  suiteKey = snap.suiteKey;
  casesKey = snap.casesKey;
  (el('prompt') as HTMLTextAreaElement).value = snap.prompt;
  const targetSel = el('target') as HTMLSelectElement;
  if (snap.targetValue) {
    targetSel.value = snap.targetValue;
    if (targetSel.value === snap.targetValue) state.target = parseTarget(snap.targetValue);
  }
  // Restore the tool-defs editor + dropdown so tool tests survive a reopen.
  if (state.tools.length) {
    (el('toolDefs') as HTMLTextAreaElement).value = JSON.stringify(state.tools, null, 2);
    const status = el('toolDefsStatus');
    status.textContent = `✓ ${state.tools.length} tool${state.tools.length === 1 ? '' : 's'} defined`;
    status.className = 'toolstatus ok';
  }
  populateExpectedToolSelect();
}

// `bare` controls the option value: the target select needs "provider/model"; the
// judge select needs a bare model id (it always runs on the target's provider).
function appendCatalogGroups(sel: HTMLSelectElement, settings: Settings, bare: boolean): void {
  for (const p of PROVIDER_ORDER) {
    const group = document.createElement('optgroup');
    const listed = settings.availableModels?.[p];
    const options = listed && listed.length > 0 ? listed.map((id) => ({ id, label: id })) : MODEL_CATALOG[p];
    group.label = listed && listed.length > 0 ? `${PROVIDER_LABEL[p]} · your key` : PROVIDER_LABEL[p];
    for (const m of options) {
      const opt = document.createElement('option');
      opt.value = bare ? m.id : `${p}/${m.id}`;
      opt.textContent = m.label;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  if (settings.customModel) {
    try {
      const t = parseTarget(settings.customModel);
      const group = document.createElement('optgroup');
      group.label = 'Custom';
      const opt = document.createElement('option');
      opt.value = bare ? t.model : settings.customModel;
      opt.textContent = `Custom · ${t.model}`;
      group.appendChild(opt);
      sel.appendChild(group);
    } catch {
      /* ignore malformed custom id */
    }
  }
}

function fillTargetSelect(sel: HTMLSelectElement, settings: Settings): void {
  sel.innerHTML = '';
  appendCatalogGroups(sel, settings, false);
}

function fillJudgeSelect(sel: HTMLSelectElement, settings: Settings): void {
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Auto — same as target';
  sel.appendChild(auto);
  appendCatalogGroups(sel, settings, true);
}

function defaultValue(settings: Settings): string {
  return settings.defaultTarget
    ? `${settings.defaultTarget.provider}/${settings.defaultTarget.model}`
    : DEFAULT_TARGET_VALUE;
}

const el = (id: string): HTMLElement => {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n;
};
const html = (id: string, markup: string): void => {
  el(id).innerHTML = markup;
};

function show(step: View): void {
  for (const s of VIEWS) el(`view-${s}`).classList.toggle('hidden', s !== step);
  // The rail tracks the test pipeline only; off-pipeline views (generate) clear it.
  const railEl = el('rail');
  const rail = railEl.children;
  const idx = (STEPS as readonly string[]).indexOf(step);
  for (let i = 0; i < rail.length; i++) {
    (rail[i] as HTMLElement).className = i < idx ? 'done' : i === idx ? 'now' : '';
  }
  // Expose pipeline position to assistive tech (the rail is otherwise color-only).
  if (idx >= 0) railEl.setAttribute('aria-valuenow', String(idx + 1));
  // Move focus to the new view's heading so keyboard/screen-reader users aren't
  // stranded on a now-hidden control and the screen change is announced.
  const heading = document.querySelector<HTMLElement>(`#view-${step} .h-lead`);
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: false });
  }
}

function setMessage(text: string, kind: 'info' | 'error' = 'info'): void {
  const msg = el('msg');
  msg.textContent = text;
  msg.classList.toggle('hidden', text === '');
  msg.classList.toggle('error', kind === 'error');
}

function targetValue(): string {
  return (el('target') as HTMLSelectElement).value;
}

async function wiring() {
  const settings = await loadSettings(area);
  const target = parseTarget(targetValue());
  const w = buildWiring(settings, target, getProvider);
  return { settings, target, w };
}

function currentProvider() {
  return parseTarget(targetValue()).provider;
}

async function refreshKeyState(): Promise<void> {
  const provider = currentProvider();
  const settings = await loadSettings(area);
  const hasKey = Boolean(settings.keys[provider]);
  // First-run activation: if NO provider has a key, lead with a clear "add a key
  // to start" card that deep-links into Settings, instead of letting the user
  // discover the requirement only by clicking a primary button that then fails.
  const hasAnyKey = (['openai', 'anthropic', 'google'] as ProviderId[]).some((p) => Boolean(settings.keys[p]));
  el('nokeyCard').classList.toggle('hidden', hasAnyKey);
  // The per-provider inline key box still appears when the selected provider
  // lacks a key but another one is set (so the card isn't shown).
  el('keybox').classList.toggle('hidden', hasKey || !hasAnyKey);
  el('keyLabel').textContent = `Your ${provider} key (stored only in this browser)`;
  el('keyStatus').textContent = hasKey ? `${provider} key saved` : '';
}

async function onSaveKey(): Promise<void> {
  const value = (el('apiKey') as HTMLInputElement).value.trim();
  if (!value) return setMessage('Enter a key first.', 'error');
  try {
    await setKey(area, currentProvider(), value);
    (el('apiKey') as HTMLInputElement).value = '';
    setMessage('');
    await refreshKeyState();
  } catch {
    setMessage('That key looked invalid.', 'error');
  }
}

/**
 * Runs IN the active page (injected via chrome.scripting). Self-contained — no
 * outside references. Heuristically finds the system-prompt editor on any console:
 * prefers an editor near a "system" label, else the largest filled editor.
 */
function grabFromPage(): string {
  const val = (el: Element): string => {
    const ta = el as HTMLTextAreaElement;
    return (typeof ta.value === 'string' ? ta.value : el.textContent ?? '').trim();
  };
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 40 && r.height > 18;
  };
  const nearSystemLabel = (el: Element): boolean => {
    let node: Element | null = el;
    for (let i = 0; i < 5 && node; i++) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      for (const leaf of Array.from(parent.querySelectorAll('*'))) {
        if (leaf.children.length === 0) {
          const t = (leaf.textContent ?? '').trim().toLowerCase();
          if (t.length <= 16 && t.includes('system')) return true;
        }
      }
      node = parent;
    }
    return false;
  };
  const sel = 'textarea, [contenteditable="true"], [role="textbox"], .cm-content';
  const candidates = Array.from(document.querySelectorAll(sel)).filter((e) => visible(e) && val(e).length > 0);
  let best = '';
  let bestScore = -1;
  for (const c of candidates) {
    const text = val(c);
    const score = text.length + (nearSystemLabel(c) ? 100000 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = text;
    }
  }
  return best;
}

async function onGrab(): Promise<void> {
  setMessage('');
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId === undefined) return setMessage('No active tab to grab from.', 'error');
    const injections = await chrome.scripting.executeScript({ target: { tabId }, func: grabFromPage });
    const text = (injections[0]?.result as string | undefined) ?? '';
    if (text) {
      (el('prompt') as HTMLTextAreaElement).value = text;
      state.prompt = text;
      setMessage('Grabbed the prompt from the page.');
    } else {
      setMessage('No prompt field found on this page — paste it instead.', 'info');
    }
  } catch {
    setMessage('Cannot grab from this page (browser pages block extensions). Paste it instead.', 'info');
  }
}

function busy(id: string, label: string): () => void {
  // Tolerant: if the button isn't in the DOM, this is a no-op rather than throwing.
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) return () => {};
  const prev = btn.textContent ?? '';
  btn.disabled = true;
  btn.textContent = label;
  return () => {
    btn.disabled = false;
    btn.textContent = prev;
  };
}

/** Switch the Capture-step testing mode and relabel the primary button. */
function setMode(mode: 'quality' | 'tools'): void {
  state.mode = mode;
  el('modeQuality').setAttribute('aria-pressed', String(mode === 'quality'));
  el('modeTools').setAttribute('aria-pressed', String(mode === 'tools'));
  el('modeMcp').setAttribute('aria-pressed', 'false');
  el('analyzeBtn').textContent = mode === 'tools' ? 'Set up tool & agent tests →' : 'Analyze prompt →';
  // The express "Just run it" path is a quality-mode shortcut (it auto-generates
  // rubrics + cases); tool/agent suites are authored by hand, so hide it there.
  el('quickRunRow').classList.toggle('hidden', mode !== 'quality');
  persistSession();
}

/** MCP is an off-pipeline mode: pressing its chip navigates to the MCP view. */
function onMcpMode(): void {
  el('modeQuality').setAttribute('aria-pressed', 'false');
  el('modeTools').setAttribute('aria-pressed', 'false');
  el('modeMcp').setAttribute('aria-pressed', 'true');
  show('mcp');
}

/** The Capture primary button — routes by mode (rubric flow vs. straight to tests). */
function onCapturePrimary(): void {
  if (state.mode === 'tools') void onToToolTests();
  else void onAnalyze();
}

const EXAMPLE_PROMPT =
  'You are a support-triage assistant. Classify each ticket into Billing, Bug, How-to, or Account. Return JSON with category, urgency (1-5), and a short reason.';

/** Fill the editor with a ready-made example so a first-run user can try the loop. */
function onLoadExample(): void {
  const ta = el('prompt') as HTMLTextAreaElement;
  ta.value = EXAMPLE_PROMPT;
  state.prompt = EXAMPLE_PROMPT;
  persistSession();
  setMessage('Loaded an example prompt — edit it or run it as-is.');
  ta.focus();
}

/**
 * Express path (quality mode): auto-generate the eval suite + cases silently and
 * go straight to the run, collapsing the 8-step pipeline to one click. The
 * detailed Analyze / Eval-prompts / Coverage screens remain available as
 * "tune this" drill-downs; this is the fast lane to a first score.
 */
async function onQuickRun(): Promise<void> {
  setMessage('');
  state.prompt = (el('prompt') as HTMLTextAreaElement).value.trim();
  if (!state.prompt) return setMessage('Paste or load a prompt first.', 'error');
  let ctx;
  try {
    ctx = await wiring();
  } catch (e) {
    el('nokeyCard').classList.remove('hidden');
    return setMessage(e instanceof Error ? e.message : 'Add an API key in Settings to start.', 'info');
  }
  state.target = ctx.target;
  show('run');
  el('runStatus').textContent = 'Auto-generating evaluation…';
  el('runProgress').textContent = '';
  try {
    const key = sessionKey(ctx);
    if (suiteKey !== key || Object.keys(state.rubrics).length === 0) {
      const suite = await generateEvalSuite(state.prompt, suiteDeps(ctx), undefined, (dim, i, t) =>
        (el('runStatus').textContent = `Writing rubric ${i}/${t}: ${dim}…`),
      );
      state.dimensions = suite.dimensions;
      state.rubrics = suite.rubrics;
      suiteKey = key;
    }
    el('runStatus').textContent = 'Generating test cases…';
    await ensureCases(false);
    persistSession();
    await onRun();
  } catch (err) {
    setMessage(describeError(err), 'error');
    show('capture');
  }
}

/** Tool/agent mode: capture prompt + target, then go straight to Cases (no rubric steps). */
async function onToToolTests(): Promise<void> {
  setMessage('');
  state.prompt = (el('prompt') as HTMLTextAreaElement).value;
  let ctx;
  try {
    ctx = await wiring();
  } catch (e) {
    el('keybox').classList.remove('hidden');
    return setMessage(e instanceof Error ? e.message : 'Setup needed.', 'info');
  }
  state.target = ctx.target;
  persistSession();
  await renderCasesView();
  (el('toolPanel') as HTMLDetailsElement).open = true;
}

/* ---- Prompt builder (interactive system-prompt generator) ---- */

// The interview transcript shown to the user, and the raw turns sent to the model.
// Kept module-level (like sessionVersions) so revisiting the builder keeps context.
let builderLog: BuilderTurnVM[] = [];
let builderConversation: ChatMessage[] = [];
let builderGenerated = '';
// True while a turn is in flight — renders a typing indicator at the end of the log.
let builderPending = false;

const BUILDER_GREETING =
  "Tell me what you want this assistant to do — its job, who it's for, and anything it must always or never do. I'll ask a couple of questions, then write the prompt.";

const BUILDER_PENDING_BUBBLE =
  '<div class="bub lit pending" aria-label="litmus is thinking"><span class="dots"><i></i><i></i><i></i></span></div>';

function renderBuilderLog(): void {
  html('builderLog', builderLogHtml(builderLog) + (builderPending ? BUILDER_PENDING_BUBBLE : ''));
  const log = el('builderLog');
  log.scrollTop = log.scrollHeight;
}

/** Open the builder, seeding a fresh interview only the first time (keeps state on revisit). */
function openBuilder(): void {
  setMessage('');
  if (builderLog.length === 0) builderLog = [{ who: 'litmus', text: BUILDER_GREETING }];
  renderBuilderLog();
  show('generate');
}

/** Append a model turn to the transcript + raw conversation; surface a generated prompt. */
function applyBuilderTurn(turn: PromptBuilderTurn): void {
  builderConversation.push({ role: 'assistant', content: JSON.stringify(turn) });
  if (turn.kind === 'question') {
    builderLog.push({ who: 'litmus', text: turn.message, suggestions: turn.suggestions });
    el('builderResultWrap').classList.add('hidden');
    el('builderUseRow').classList.add('hidden');
  } else {
    builderGenerated = turn.systemPrompt;
    if (turn.summary) builderLog.push({ who: 'litmus', text: turn.summary });
    (el('builderResult') as HTMLTextAreaElement).value = turn.systemPrompt;
    el('builderResultWrap').classList.remove('hidden');
    el('builderUseRow').classList.remove('hidden');
  }
  renderBuilderLog();
}

async function runBuilderTurn(forceGenerate: boolean): Promise<void> {
  let ctx;
  try {
    ctx = await wiring();
  } catch (e) {
    el('keybox').classList.remove('hidden');
    show('capture');
    return setMessage(e instanceof Error ? e.message : 'Add an API key in settings first.', 'info');
  }
  state.target = ctx.target;
  const btnId = forceGenerate ? 'builderGenerateBtn' : 'builderSendBtn';
  const done = busy(btnId, forceGenerate ? 'Writing…' : 'Thinking…');
  builderPending = true;
  renderBuilderLog();
  try {
    const turn = await builderTurn(
      builderConversation,
      { provider: ctx.w.targetProvider, apiKey: ctx.w.targetKey, model: ctx.target.model },
      forceGenerate,
    );
    builderPending = false;
    applyBuilderTurn(turn);
  } catch (err) {
    builderPending = false;
    renderBuilderLog();
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

/** Pull any text in the input box into the transcript as a user turn. */
function pushBuilderInput(): boolean {
  const input = (el('builderInput') as HTMLTextAreaElement).value.trim();
  if (!input) return false;
  builderLog.push({ who: 'you', text: input });
  builderConversation.push({ role: 'user', content: input });
  (el('builderInput') as HTMLTextAreaElement).value = '';
  renderBuilderLog();
  return true;
}

async function onBuilderSend(): Promise<void> {
  setMessage('');
  if (!pushBuilderInput()) return setMessage('Type what you want the prompt to do.', 'error');
  await runBuilderTurn(false);
}

async function onBuilderGenerate(): Promise<void> {
  setMessage('');
  pushBuilderInput();
  if (builderConversation.length === 0) return setMessage('Describe the prompt first, then generate.', 'error');
  await runBuilderTurn(true);
}

/** Load the generated (and possibly edited) prompt into the capture flow. */
function onBuilderUse(): void {
  const text = (el('builderResult') as HTMLTextAreaElement).value.trim() || builderGenerated;
  if (!text) return setMessage('Generate a prompt first.', 'error');
  state.prompt = text;
  (el('prompt') as HTMLTextAreaElement).value = text;
  show('capture');
  void refreshVersionPicker();
  setMessage('Loaded your generated prompt — analyze or run it.');
}

async function onAnalyze(): Promise<void> {
  setMessage('');
  state.prompt = (el('prompt') as HTMLTextAreaElement).value;
  let ctx;
  try {
    ctx = await wiring();
  } catch (e) {
    el('keybox').classList.remove('hidden');
    return setMessage(e instanceof Error ? e.message : 'Setup needed.', 'info');
  }
  state.target = ctx.target;
  const done = busy('analyzeBtn', 'Analyzing…');
  try {
    state.analysis = await analyzePrompt(state.prompt, ctx.target, {
      provider: ctx.w.targetProvider,
      apiKey: ctx.w.targetKey,
      analyzerModel: ctx.target.model,
    });
    el('analyzeKicker').textContent = `How it reads on ${ctx.target.model}`;
    html('facets', facetRowsHtml(state.analysis.facets));
    html('suggest', state.analysis.suggestions.map((s) => `<div class="sd">✦ ${s}</div>`).join(''));
    persistSession();
    show('analyze');
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

function analysisHint(): string | undefined {
  return state.analysis ? state.analysis.facets.map((f) => `${f.facet}: ${f.finding}`).join('\n') : undefined;
}

function suiteDeps(ctx: Awaited<ReturnType<typeof wiring>>) {
  return { provider: ctx.w.judgeProvider, apiKey: ctx.w.judgeKey, model: ctx.w.auxModel };
}

function renderRubricHealth(): void {
  const text = (el('evalPromptText') as HTMLTextAreaElement).value;
  const node = el('rubricHealth');
  if (!text.trim()) {
    node.textContent = '';
    node.className = 'rubrichealth';
    return;
  }
  const r = checkEvalPrompt(text);
  node.className = `rubrichealth ${r.passed ? 'ok' : 'warn'}`;
  node.textContent = r.passed
    ? `Rubric health ${r.score.toFixed(1)}/10 — production-grade ✓`
    : `Rubric health ${r.score.toFixed(1)}/10 — missing: ${r.missing.slice(0, 3).join(', ')}`;
}

function renderDimensionChips(): void {
  const host = el('dimensionList');
  host.textContent = '';
  for (const d of state.dimensions) {
    const chip = document.createElement('button');
    chip.className = `dimchip${d.name === state.activeDimension ? ' on' : ''}`;
    chip.dataset['name'] = d.name;
    const dot = document.createElement('i');
    dot.className = `dot ${checkEvalPrompt(state.rubrics[d.name] ?? '').passed ? 'ok' : 'warn'}`;
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(d.name));
    host.appendChild(chip);
  }
}

function selectDimension(name: string): void {
  state.activeDimension = name;
  el('activeDimLabel').textContent = `Rubric · ${name}`;
  (el('evalPromptText') as HTMLTextAreaElement).value = state.rubrics[name] ?? '';
  renderRubricHealth();
  renderDimensionChips();
  persistSession();
}

async function onToEvalPrompt(): Promise<void> {
  setMessage('');
  const done = busy('toEvalPromptBtn', 'Finding dimensions…');
  try {
    const ctx = await wiring();
    const key = sessionKey(ctx);
    if (suiteKey === key && Object.keys(state.rubrics).length > 0) {
      setMessage('Reused this session’s eval prompt — no new model calls.');
    } else {
      const suite = await generateEvalSuite(state.prompt, suiteDeps(ctx), analysisHint(), (dim, i, total) =>
        setMessage(`Generating rubric ${i}/${total}: ${dim}…`),
      );
      state.dimensions = suite.dimensions;
      state.rubrics = suite.rubrics;
      suiteKey = key;
      persistSession();
      setMessage('');
    }
    const first = state.dimensions[0]?.name ?? '';
    show('evalprompt');
    selectDimension(first);
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

async function onAddDimension(): Promise<void> {
  const input = el('newDimension') as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return setMessage('Name the dimension to add.', 'error');
  setMessage('');
  const done = busy('addDimBtn', 'Generating…');
  try {
    const ctx = await wiring();
    const rubric = await generateEvalPrompt(state.prompt, name, suiteDeps(ctx), analysisHint());
    if (!state.dimensions.some((d) => d.name === name)) {
      state.dimensions = [...state.dimensions, { name, description: 'user-added' }];
    }
    state.rubrics = { ...state.rubrics, [name]: rubric };
    input.value = '';
    // Coverage is computed over the dimension set — invalidate the cached panel.
    el('coverageHost').innerHTML = '';
    el('coverageHost').classList.add('hidden');
    selectDimension(name);
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

async function onRegenEvalPrompt(): Promise<void> {
  if (!state.activeDimension) return;
  setMessage('');
  const done = busy('epRegenBtn', 'Regenerating…');
  try {
    const ctx = await wiring();
    state.rubrics = {
      ...state.rubrics,
      [state.activeDimension]: await generateEvalPrompt(state.prompt, state.activeDimension, suiteDeps(ctx), analysisHint()),
    };
    selectDimension(state.activeDimension);
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

function onEvalPromptEdited(): void {
  if (!state.activeDimension) return;
  state.rubrics = { ...state.rubrics, [state.activeDimension]: (el('evalPromptText') as HTMLTextAreaElement).value };
  renderRubricHealth();
  renderDimensionChips();
  persistSession();
}

function onCopyEvalPrompt(): void {
  void navigator.clipboard?.writeText((el('evalPromptText') as HTMLTextAreaElement).value);
  setMessage('Rubric copied to clipboard.');
}

function onEvalPromptContinue(): void {
  void showCases(false);
}

async function onCheckCoverage(): Promise<void> {
  if (state.dimensions.length === 0) return;
  const host = el('coverageHost');
  // Toggle: if already shown, collapse it. If loaded but hidden, just re-show
  // it (no model call). Only fetch coverage when there's nothing cached.
  if (!host.classList.contains('hidden')) {
    host.classList.add('hidden');
    return;
  }
  if (host.innerHTML.trim()) {
    host.classList.remove('hidden');
    return;
  }
  setMessage('');
  const done = busy('coverageBtn', 'Checking…');
  try {
    const ctx = await wiring();
    const rows = await analyzeCoverage(state.prompt, state.dimensions.map((d) => d.name), suiteDeps(ctx));
    html('coverageHost', coverageHtml(rows));
    host.classList.remove('hidden');
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

async function ensureCases(force: boolean): Promise<void> {
  const ctx = await wiring();
  const key = sessionKey(ctx);
  // Reuse cases already generated for this prompt + models unless forced.
  if (!force && casesKey === key && state.cases.length > 0) return;
  state.cases = await generateCases(
    state.prompt,
    ctx.target,
    DEFAULT_CASE_COUNT,
    { provider: ctx.w.judgeProvider, apiKey: ctx.w.judgeKey, model: ctx.w.auxModel },
    analysisHint(),
  );
  casesKey = key;
  persistSession();
}

/** Render the cases list + cost estimate and reflect the spend cap. Returns whether over cap. */
async function renderCasesView(): Promise<boolean> {
  html('casesHost', casesListHtml(state.cases));
  const { settings, target, w } = await wiring();
  const toolsMode = state.mode === 'tools';
  const samples = Math.max(1, settings.samples);
  // Tool/agent cases are scored deterministically (no judge, no fixes pass). An
  // agent scenario is a multi-turn loop, so it costs up to maxSteps model calls;
  // a tool-assertion case is a single call. Quality cases keep the judge+fixes shape.
  const est = toolsMode
    ? estimateRun({
        caseCount: state.cases.reduce((n, c) => n + (c.scenario ? c.scenario.maxSteps : 1), 0) * samples,
        targetModel: target.model,
        judgeModel: w.auxModel,
        analyzerModel: w.auxModel,
        includeAnalysis: false,
        includeEvalGen: false,
        includeJudge: false,
        includeFixes: false,
        avgInputTokens: 600,
        avgOutputTokens: 400,
      })
    : estimateRun({
        caseCount: state.cases.length * samples,
        targetModel: target.model,
        judgeModel: w.auxModel,
        analyzerModel: w.auxModel,
        includeAnalysis: false,
        includeEvalGen: false,
        includeFixes: true,
        judgeSamples: settings.judgeSamples,
        avgInputTokens: 600,
        avgOutputTokens: 400,
      });
  const over = exceedsCap(est, settings.spendCapUsd);
  el('costLine').textContent = `${formatUsd(est.estUsd)} · ${est.totalCalls} calls · cap ${formatUsd(settings.spendCapUsd)}`;
  (el('runBtn') as HTMLButtonElement).disabled = over;
  // Tool/agent mode tests tools, not text outputs — hide the text-case generators.
  el('regenBtn').classList.toggle('hidden', toolsMode);
  el('moreCasesBtn').classList.toggle('hidden', toolsMode);
  // The tool/agent authoring panels belong to tools mode only; in quality mode
  // they duplicate the dedicated Tool & agent mode and just add clutter.
  el('toolPanel').classList.toggle('hidden', !toolsMode);
  el('agentPanel').classList.toggle('hidden', !toolsMode);
  setMessage(over ? 'Estimated cost exceeds your cap. Raise the cap or trim cases.' : '', over ? 'error' : 'info');
  show('cases');
  return over;
}

async function showCases(force = false): Promise<void> {
  const done = busy('epContinueBtn', 'Generating cases…');
  try {
    await ensureCases(force);
    await renderCasesView();
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

/** Generate MORE_CASE_COUNT additional cases and append them (does not replace). */
async function onMoreCases(): Promise<void> {
  const done = busy('moreCasesBtn', `+${MORE_CASE_COUNT}…`);
  try {
    const ctx = await wiring();
    // Continue IDs past the highest existing suffix so removals can't cause collisions.
    const maxN = state.cases.reduce((m, c) => {
      const n = Number(/(\d+)$/.exec(c.id)?.[1] ?? NaN);
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    const existing = state.cases.map((c) => `- ${c.input}`).join('\n');
    const hint =
      [
        analysisHint(),
        existing &&
          `Cases already generated — produce ${MORE_CASE_COUNT} NEW, distinct cases that do NOT duplicate these:\n${existing}`,
      ]
        .filter(Boolean)
        .join('\n') || undefined;
    const more = await generateCases(
      state.prompt,
      ctx.target,
      MORE_CASE_COUNT,
      {
        provider: ctx.w.judgeProvider,
        apiKey: ctx.w.judgeKey,
        model: ctx.w.auxModel,
        makeId: (i) => `case-${maxN + i + 1}`,
      },
      hint,
    );
    state.cases = [...state.cases, ...more];
    persistSession();
    const over = await renderCasesView();
    if (!over) setMessage(`Added ${more.length} cases — ${state.cases.length} total.`);
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

/* ---- Tool tests (ADR 0001) ---- */

const ToolDefsSchema = z.array(ToolDefSchema);

/** Highest numeric suffix among existing case ids (0 if none). */
function maxCaseSuffix(): number {
  return state.cases.reduce((m, c) => {
    const n = Number(/(\d+)$/.exec(c.id)?.[1] ?? NaN);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
}

/** Next free case id past the highest numeric suffix in use. */
function nextCaseId(): string {
  return `case-${maxCaseSuffix() + 1}`;
}

/** Auto-generate tool-test cases from the defined catalog and append them. */
async function onGenerateToolCases(): Promise<void> {
  if (state.tools.length === 0) return setMessage('Define at least one tool first.', 'error');
  const done = busy('genToolCasesBtn', 'Generating…');
  try {
    const ctx = await wiring();
    const start = maxCaseSuffix();
    const more = await generateToolCases(
      state.prompt,
      state.tools,
      TOOL_CASE_COUNT,
      {
        provider: ctx.w.judgeProvider,
        apiKey: ctx.w.judgeKey,
        model: ctx.w.auxModel,
        makeId: (i) => `case-${start + i + 1}`,
      },
      analysisHint(),
    );
    state.cases = [...state.cases, ...more];
    persistSession();
    const over = await renderCasesView();
    if (!over) setMessage(`Added ${more.length} tool tests — ${state.cases.length} cases total.`);
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

/** Fill the expected-tool dropdown from the parsed tool catalog. */
function populateExpectedToolSelect(): void {
  const sel = el('toolExpected') as HTMLSelectElement;
  sel.replaceChildren();
  const any = document.createElement('option');
  any.value = '';
  any.textContent = state.tools.length ? '(any / none)' : 'define tools first';
  sel.appendChild(any);
  for (const t of state.tools) {
    const o = document.createElement('option');
    o.value = t.name;
    o.textContent = t.name;
    sel.appendChild(o);
  }
}

/** Parse + validate the tool-definitions textarea, updating state and status. */
function onToolDefsChanged(): void {
  const raw = (el('toolDefs') as HTMLTextAreaElement).value.trim();
  const status = el('toolDefsStatus');
  if (!raw) {
    state.tools = [];
    status.textContent = '';
    status.className = 'toolstatus';
    populateExpectedToolSelect();
    persistSession();
    return;
  }
  try {
    state.tools = ToolDefsSchema.parse(JSON.parse(raw));
    status.textContent = `✓ ${state.tools.length} tool${state.tools.length === 1 ? '' : 's'} defined`;
    status.className = 'toolstatus ok';
  } catch (err) {
    state.tools = [];
    status.textContent = err instanceof SyntaxError ? 'Invalid JSON' : 'Tool defs must be [{name, parameters}]';
    status.className = 'toolstatus err';
  }
  populateExpectedToolSelect();
  persistSession();
}

/** Build a tool-test case from the mini-form and append it to the case list. */
async function onAddToolCase(): Promise<void> {
  const input = (el('toolCaseInput') as HTMLInputElement).value.trim();
  if (!input) return setMessage('Add a user message for the tool test.', 'error');
  const expectedTool = (el('toolExpected') as HTMLSelectElement).value;
  const forbidden = (el('toolForbidden') as HTMLInputElement).value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const argsRaw = (el('toolRequiredArgs') as HTMLInputElement).value.trim();
  let requiredArgs: Record<string, unknown> | undefined;
  if (argsRaw) {
    try {
      requiredArgs = JSON.parse(argsRaw) as Record<string, unknown>;
    } catch {
      return setMessage('Required args must be valid JSON.', 'error');
    }
  }
  const toolExpectations: ToolExpectation = {
    ...(expectedTool ? { expectedTool } : {}),
    ...(forbidden.length ? { forbiddenTools: forbidden } : {}),
    ...(requiredArgs ? { requiredArgs } : {}),
  };
  state.cases = [...state.cases, { id: nextCaseId(), category: 'typical', input, pinned: false, toolExpectations }];
  (el('toolCaseInput') as HTMLInputElement).value = '';
  (el('toolForbidden') as HTMLInputElement).value = '';
  (el('toolRequiredArgs') as HTMLInputElement).value = '';
  persistSession();
  await renderCasesView();
  setMessage(`Added tool test — ${state.cases.length} cases total.`);
}

/** Parse the scenario JSON and append it as a multi-turn agent case (ADR 0002). */
async function onAddScenario(): Promise<void> {
  const raw = (el('scenarioJson') as HTMLTextAreaElement).value.trim();
  const status = el('scenarioStatus');
  if (!raw) {
    status.textContent = 'Paste a scenario JSON first.';
    status.className = 'toolstatus err';
    return;
  }
  let scenario;
  try {
    scenario = ScenarioSchema.parse(JSON.parse(raw));
  } catch (err) {
    status.textContent = err instanceof SyntaxError ? 'Invalid JSON' : 'Scenario needs goal, tools[], and maxSteps (1–20).';
    status.className = 'toolstatus err';
    return;
  }
  status.textContent = `✓ scenario "${scenario.goal.slice(0, 40)}${scenario.goal.length > 40 ? '…' : ''}" added`;
  status.className = 'toolstatus ok';
  state.cases = [...state.cases, { id: nextCaseId(), category: 'typical', input: scenario.goal, pinned: false, scenario }];
  (el('scenarioJson') as HTMLTextAreaElement).value = '';
  persistSession();
  await renderCasesView();
  setMessage(`Added agent scenario — ${state.cases.length} cases total.`);
}

// Active run's abort controller, so the Cancel button can halt an in-flight run
// (providers honor the signal mid-stream). Null when no run is in progress.
let runAbort: AbortController | null = null;

function onCancelRun(): void {
  runAbort?.abort();
  el('runStatus').textContent = 'Canceling…';
}

async function onRun(): Promise<void> {
  setMessage('');
  if (state.cases.length === 0) {
    return setMessage(
      state.mode === 'tools' ? 'Add a tool test or agent scenario first.' : 'No cases to run — generate some first.',
      'error',
    );
  }
  show('run');
  const ac = new AbortController();
  runAbort = ac;
  const total = state.cases.length;
  el('runProgress').textContent = `0 / ${total} cases`;
  try {
    const { settings, target, w } = await wiring();
    el('runStatus').textContent = `Running ${total} cases on ${target.model}…`;
    const outcome = await runEval(state.prompt, state.cases, {
      target,
      targetProvider: w.targetProvider,
      targetKey: w.targetKey,
      judgeProvider: w.judgeProvider,
      judgeKey: w.judgeKey,
      judgeModel: w.auxModel,
      rubric: combineRubrics(state.rubrics) || undefined,
      passThreshold: settings.passThreshold,
      samples: settings.samples,
      judgeSamples: settings.judgeSamples,
      concurrency: settings.concurrency,
      signal: ac.signal,
      onProgress: (done, t) => {
        el('runProgress').textContent = `${done} / ${t} cases`;
      },
      ...(state.tools.length ? { tools: state.tools } : {}),
      ...(settings.mcpServers?.length ? { mcpServers: settings.mcpServers } : {}),
    });
    state.outcome = outcome;

    // Rubric health is a quality-mode concept (it measures the judge rubric's
    // discrimination/consistency). Tool & agent cases are scored deterministically
    // with no rubric, so skip it — running it would only waste judge calls.
    if (state.mode === 'tools') {
      state.rubricHealth = null;
    } else {
      const combined = combineRubrics(state.rubrics) || undefined;
      state.rubricHealth = await validateRubric(state.prompt, state.cases, outcome.results, {
        provider: w.judgeProvider,
        apiKey: w.judgeKey,
        model: w.auxModel,
        rubric: combined,
      }).catch(() => null);
    }

    const existing = await store.getVersions();
    const index = existing.length + 1;
    const prev = existing[existing.length - 1];
    // Truthful note: distinguish a prompt edit, a re-run, and a same-prompt model
    // swap (the model-comparison case) so the timeline tells the right story.
    const samePrompt = Boolean(prev && prev.text === state.prompt);
    const modelChanged = Boolean(prev?.target && prev.target.model !== target.model);
    const note =
      index === 1
        ? 'baseline'
        : samePrompt
          ? modelChanged
            ? `same prompt · ${target.model}`
            : 're-run (no change)'
          : 'edited prompt';
    const version = {
      id: `v${index}`,
      index,
      text: state.prompt,
      note,
      parentId: state.lastVersionId,
      createdAt: Date.now(),
      target: { provider: target.provider, model: target.model },
    };
    await store.putVersion(version);
    await store.putRun({
      versionId: version.id,
      summary: outcome.summary,
      results: outcome.results,
      dimensions: aggregateDimensions(outcome.results),
      ...(state.rubricHealth ? { rubricHealth: state.rubricHealth } : {}),
      createdAt: version.createdAt,
    });
    state.lastVersionId = version.id;

    renderResults(version.index);
    show('results');
  } catch (err) {
    if (ac.signal.aborted) {
      setMessage('Run canceled — no version saved.');
    } else {
      setMessage(describeError(err), 'error');
    }
    show('cases');
  } finally {
    if (runAbort === ac) runAbort = null;
  }
}

function renderResults(versionIndex: number): void {
  // Results render only makes sense with a run in hand; guard the non-null access
  // so an unexpected navigation (e.g. a restored session) can't crash the view.
  if (!state.outcome) {
    setMessage('No run to show — run an eval first.', 'info');
    show('cases');
    return;
  }
  const s = state.outcome.summary;
  const b = band(s.overall);
  html(
    'scoreHost',
    `<div class="scorehero"><div class="big ${b}">${s.overall.toFixed(1)}</div>` +
      `<div class="sx"><div class="sk">Overall · v${versionIndex}</div>` +
      `<div class="sv">${s.passCount} passed · ${s.failCount} failed</div></div></div>`,
  );
  html('speedHost', speedStripHtml(s.speed));
  const rubricNode = el('rubricHost');
  if (state.rubricHealth) {
    rubricNode.classList.remove('hidden');
    html('rubricHost', `<span class="rhlabel">Rubric health</span> ${rubricHealthHtml(state.rubricHealth)}`);
  } else {
    rubricNode.classList.add('hidden');
  }
  html('resultsHost', resultsTableHtml(state.outcome!.results, 6, state.cases));
  // "What to fix" generates text-prompt rewrites from quality judging — irrelevant
  // for deterministic tool/agent results. Hide it there and let Versions lead.
  const toolsMode = state.mode === 'tools';
  el('fixBtn').classList.toggle('hidden', toolsMode);
  el('resultsVersionsBtn').classList.toggle('btn-primary-promote', toolsMode);
}

async function onFixes(): Promise<void> {
  const done = busy('fixBtn', 'Thinking…');
  try {
    const { w } = await wiring();
    state.fixes = await suggestFixes(state.prompt, state.cases, state.outcome!.results, {
      provider: w.judgeProvider,
      apiKey: w.judgeKey,
      model: w.auxModel,
    });
    html('fixesHost', fixesListHtml(state.fixes));
    show('fixes');
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

/**
 * "Apply fixes & re-run": auto-apply the suggested fixes to the system prompt
 * (one rewrite call), then drop the user on capture with the revised prompt so
 * they can review before re-running. Changing the prompt invalidates the cached
 * suite + cases (the session key changes), so the next pass regenerates them.
 */
async function onApplyFixesAndEdit(): Promise<void> {
  if (state.fixes.length === 0) {
    goCapture();
    return;
  }
  const done = busy('fixesEditBtn', 'Applying fixes…');
  try {
    const { w } = await wiring();
    const revised = await applyFixes(state.prompt, state.fixes, {
      provider: w.judgeProvider,
      apiKey: w.judgeKey,
      model: w.auxModel,
    });
    state.prompt = revised;
    (el('prompt') as HTMLTextAreaElement).value = revised;
    persistSession();
    show('capture');
    void refreshVersionPicker();
    setMessage(`Applied ${state.fixes.length} fix${state.fixes.length === 1 ? '' : 'es'} to your prompt — review, then re-run.`);
  } catch (err) {
    setMessage(describeError(err), 'error');
  } finally {
    done();
  }
}

// Versions + their runs, cached for the versions screen so the compare pickers
// can re-render the axis without refetching from the store.
let axisVersions: PromptVersion[] = [];
const axisRuns = new Map<string, RunRecord | null>();
// Which screen the Versions view was opened from, so Back returns there.
let versionsReturnTo: View = 'results';

async function showVersions(from: View = 'results'): Promise<void> {
  versionsReturnTo = from;
  const versions = await store.getVersions();
  axisVersions = versions;
  axisRuns.clear();
  const vms: VersionVM[] = [];
  let prev: number | null = null;
  for (const v of versions) {
    const run = await store.getRun(v.id);
    axisRuns.set(v.id, run);
    const overall = run?.summary.overall ?? 0;
    vms.push({
      label: `v${v.index}`,
      note: v.note,
      overall,
      passLabel: run ? `${run.summary.passCount}/${run.summary.total}` : '—',
      avgSeconds: run ? round1(run.summary.speed.avgResponseMs / 1000) : 0,
      delta: prev === null ? null : round1(overall - prev),
      current: v.id === state.lastVersionId,
      ...(v.target ? { model: v.target.model } : {}),
    });
    prev = overall;
  }
  html('versionsHost', versionsTimelineHtml(vms));

  // Compare pickers: default to baseline (A) vs latest (B), preserving the old
  // first-vs-last behavior, but let the user choose any two versions — which is
  // how you compare the SAME prompt across two models.
  fillCompareSelect(el('compareA') as HTMLSelectElement, versions[0]?.id ?? '');
  fillCompareSelect(el('compareB') as HTMLSelectElement, versions[versions.length - 1]?.id ?? '');
  renderAxisPair();
  show('versions');
}

/** Fill a compare dropdown with every version, selecting `selectedId`. */
function fillCompareSelect(sel: HTMLSelectElement, selectedId: string): void {
  sel.replaceChildren();
  for (const v of axisVersions) {
    const opt = document.createElement('option');
    opt.value = v.id;
    const model = v.target ? ` · ${v.target.model}` : '';
    opt.textContent = `v${v.index}${model}`;
    sel.appendChild(opt);
  }
  sel.value = selectedId;
}

/** Render the litmus axis for the two currently-selected versions, with a header. */
function renderAxisPair(): void {
  const axisWrap = el('axisWrap');
  const aId = (el('compareA') as HTMLSelectElement).value;
  const bId = (el('compareB') as HTMLSelectElement).value;
  const a = axisVersions.find((v) => v.id === aId);
  const b = axisVersions.find((v) => v.id === bId);
  const aDims = a ? axisRuns.get(a.id)?.dimensions ?? [] : [];
  const bDims = b ? axisRuns.get(b.id)?.dimensions ?? [] : [];
  if (!a || !b || a.id === b.id || aDims.length === 0 || bDims.length === 0) {
    axisWrap.classList.add('hidden');
    return;
  }
  const cmp = describeComparison(
    { label: `v${a.index}`, promptText: a.text, ...(a.target ? { model: a.target.model } : {}) },
    { label: `v${b.index}`, promptText: b.text, ...(b.target ? { model: b.target.model } : {}) },
  );
  el('axisHeader').innerHTML = axisHeaderHtml(cmp.header);
  el('axisKeyA').textContent = `◀ v${a.index}`;
  el('axisKeyB').textContent = `v${b.index} ▶`;
  html('axisHost', axisRowsHtml(buildAxis(aDims, bDims)));
  axisWrap.classList.remove('hidden');
}

async function reportEntries(): Promise<ReportEntry[]> {
  const versions = await store.getVersions();
  const entries: ReportEntry[] = [];
  for (const v of versions) {
    const run = await store.getRun(v.id);
    entries.push({
      label: `v${v.index}`,
      note: v.note,
      prompt: v.text,
      ...(v.target ? { model: v.target.model } : {}),
      run: run
        ? {
            overall: run.summary.overall,
            passCount: run.summary.passCount,
            failCount: run.summary.failCount,
            total: run.summary.total,
            speed: run.summary.speed,
          }
        : null,
    });
  }
  return entries;
}

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportReport(format: 'md' | 'json'): Promise<void> {
  const entries = await reportEntries();
  if (entries.length === 0) return setMessage('Nothing to export yet — run the loop first.', 'info');
  if (format === 'md') download('litmus-report.md', buildMarkdownReport(entries), 'text/markdown');
  else download('litmus-report.json', buildJsonReport(entries), 'application/json');
}

function goCapture(): void {
  (el('prompt') as HTMLTextAreaElement).value = state.prompt || (el('prompt') as HTMLTextAreaElement).value;
  show('capture');
  void refreshVersionPicker();
}

// Versions saved this session, newest last — backs the capture-screen picker.
let sessionVersions: PromptVersion[] = [];

/**
 * Populate the capture-screen version dropdown. The picker is for switching to a
 * DIFFERENT version, so the prompt currently under test is excluded — you only
 * see the other versions you could load. Hidden when there's nothing else to load.
 */
async function refreshVersionPicker(): Promise<void> {
  sessionVersions = [...(await store.getVersions())];
  const wrap = el('versionPickerWrap');
  const sel = el('versionPicker') as HTMLSelectElement;
  // Exclude the version that is the current prompt under test.
  const loadable = sessionVersions.filter((v) => v.text !== state.prompt);
  if (loadable.length === 0) {
    wrap.classList.add('hidden');
    return;
  }
  // Pull each loadable version's run so the label can show its overall score.
  const scores = new Map<string, number>();
  await Promise.all(
    loadable.map(async (v) => {
      const run = await store.getRun(v.id);
      if (run) scores.set(v.id, run.summary.overall);
    }),
  );
  sel.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Load a different version…';
  sel.appendChild(placeholder);
  for (let i = loadable.length - 1; i >= 0; i--) {
    const v = loadable[i];
    if (!v) continue;
    const score = scores.has(v.id) ? ` · ${round1(scores.get(v.id)!)}/10` : '';
    const model = v.target ? ` · ${v.target.model}` : '';
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `v${v.index} · ${v.note}${model}${score}`;
    sel.appendChild(opt);
  }
  sel.value = '';
  wrap.classList.remove('hidden');
}

/** Load the chosen version's prompt back into the editor. */
function onPickVersion(): void {
  const sel = el('versionPicker') as HTMLSelectElement;
  const v = sessionVersions.find((x) => x.id === sel.value);
  if (!v) return;
  const promptEl = el('prompt') as HTMLTextAreaElement;
  const identical = promptEl.value === v.text;
  state.prompt = v.text;
  promptEl.value = v.text;
  persistSession();
  // The loaded version is now the current prompt under test → drop it from the list.
  void refreshVersionPicker();
  setMessage(
    identical
      ? `v${v.index}'s prompt is identical to the one already shown — nothing changed.`
      : `Loaded v${v.index} — edit and re-run to branch from it.`,
  );
}

function setSettingsMsg(text: string, kind: 'info' | 'error' = 'info'): void {
  const m = el('settingsMsg');
  m.textContent = text;
  m.classList.toggle('hidden', text === '');
  m.classList.toggle('error', kind === 'error');
}

async function openSettings(): Promise<void> {
  const s = await loadSettings(area);
  const savedMark = (provider: 'openai' | 'anthropic' | 'google', id: string) => {
    const span = el(id);
    const has = Boolean(s.keys[provider]);
    span.textContent = has ? 'saved' : '';
    span.className = `ksaved${has ? ' on' : ''}`;
  };
  savedMark('openai', 'savedOpenai');
  savedMark('anthropic', 'savedAnthropic');
  savedMark('google', 'savedGoogle');
  (el('keyOpenai') as HTMLInputElement).value = '';
  (el('keyAnthropic') as HTMLInputElement).value = '';
  (el('keyGoogle') as HTMLInputElement).value = '';
  (el('keyOpenai') as HTMLInputElement).placeholder = s.keys.openai ? 'leave blank to keep' : 'sk-…';
  (el('keyAnthropic') as HTMLInputElement).placeholder = s.keys.anthropic ? 'leave blank to keep' : 'sk-ant-…';
  (el('keyGoogle') as HTMLInputElement).placeholder = s.keys.google ? 'leave blank to keep' : 'AIza…';
  const dm = el('defaultModel') as HTMLSelectElement;
  fillTargetSelect(dm, s);
  dm.value = defaultValue(s);
  const jm = el('judgeModel') as HTMLSelectElement;
  fillJudgeSelect(jm, s);
  // Normalize a legacy "provider/model" override to its bare id; unknown → Auto.
  const judgeId = s.judgeModel?.includes('/') ? s.judgeModel.slice(s.judgeModel.indexOf('/') + 1) : (s.judgeModel ?? '');
  jm.value = judgeId;
  (el('customModel') as HTMLInputElement).value = s.customModel ?? '';
  (el('passThreshold') as HTMLInputElement).value = String(s.passThreshold);
  (el('spendCap') as HTMLInputElement).value = String(s.spendCapUsd);
  (el('samples') as HTMLInputElement).value = String(s.samples);
  (el('judgeSamples') as HTMLInputElement).value = String(s.judgeSamples);
  (el('concurrency') as HTMLInputElement).value = String(s.concurrency);
  setSettingsMsg('');
  el('settingsModal').classList.remove('hidden');
  // A11y: focus the first field so keyboard users land inside the dialog (not on
  // the gear behind the overlay); remember the opener to restore focus on close.
  settingsOpener = (document.activeElement as HTMLElement | null) ?? null;
  (el('keyOpenai') as HTMLInputElement).focus();
}

// The element focus was on when Settings opened, so we can restore it on close.
let settingsOpener: HTMLElement | null = null;

function closeSettings(): void {
  el('settingsModal').classList.add('hidden');
  settingsOpener?.focus?.();
  settingsOpener = null;
}

/** Trap Tab within the dialog and close on Escape (focus-trap for the modal). */
function onSettingsKeydown(e: KeyboardEvent): void {
  if (el('settingsModal').classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSettings();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = Array.from(
    el('settingsModal').querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((n) => n.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

async function onSaveSettings(): Promise<void> {
  try {
    const current = await loadSettings(area);
    const customRaw = (el('customModel') as HTMLInputElement).value.trim();
    if (customRaw) {
      try {
        parseTarget(customRaw);
      } catch {
        return setSettingsMsg('Custom model must be "provider/model", e.g. openai/gpt-5.4.', 'error');
      }
    }
    const next = mergeSettings(current, {
      keys: {
        openai: (el('keyOpenai') as HTMLInputElement).value,
        anthropic: (el('keyAnthropic') as HTMLInputElement).value,
        google: (el('keyGoogle') as HTMLInputElement).value,
      },
      defaultTarget: parseTarget((el('defaultModel') as HTMLSelectElement).value),
      judgeModel: (el('judgeModel') as HTMLSelectElement).value,
      customModel: customRaw,
      passThreshold: Number((el('passThreshold') as HTMLInputElement).value),
      spendCapUsd: Number((el('spendCap') as HTMLInputElement).value),
      samples: Number((el('samples') as HTMLInputElement).value),
      judgeSamples: Number((el('judgeSamples') as HTMLInputElement).value),
      concurrency: Number((el('concurrency') as HTMLInputElement).value),
    });
    await saveSettings(area, next);
    // Rebuild the capture dropdown (it may now include a custom model) and apply the default.
    const targetSel = el('target') as HTMLSelectElement;
    fillTargetSelect(targetSel, next);
    targetSel.value = defaultValue(next);
    state.target = parseTarget(targetSel.value || DEFAULT_TARGET_VALUE);
    await refreshKeyState();
    closeSettings();
    setMessage('Settings saved.');
  } catch (err) {
    setSettingsMsg(err instanceof Error ? err.message : 'Could not save settings.', 'error');
  }
}

async function onLoadModels(): Promise<void> {
  const s = await loadSettings(area);
  const providers = (['openai', 'anthropic', 'google'] as ProviderId[]).filter((p) => s.keys[p]);
  if (providers.length === 0) return setSettingsMsg('Save at least one API key first.', 'error');
  setSettingsMsg('Loading models from your key(s)…');
  const available: { openai?: string[]; anthropic?: string[]; google?: string[] } = { ...s.availableModels };
  try {
    for (const p of providers) {
      const key = s.keys[p];
      if (key) available[p] = await fetchModels(p, key);
    }
    const next: Settings = { ...s, availableModels: available };
    await saveSettings(area, next);
    fillTargetSelect(el('defaultModel') as HTMLSelectElement, next);
    (el('defaultModel') as HTMLSelectElement).value = defaultValue(next);
    const jm = el('judgeModel') as HTMLSelectElement;
    fillJudgeSelect(jm, next);
    jm.value = next.judgeModel ?? '';
    setSettingsMsg(`Loaded models for: ${providers.join(', ')}. Pick one above.`);
  } catch (err) {
    setSettingsMsg(describeError(err), 'error');
  }
}

async function onDeleteKeys(): Promise<void> {
  await deleteAllKeys(area);
  setSettingsMsg('All keys deleted.');
  await openSettings();
}

async function applyDefaults(): Promise<void> {
  const s = await loadSettings(area);
  const targetSel = el('target') as HTMLSelectElement;
  fillTargetSelect(targetSel, s);
  targetSel.value = defaultValue(s);
  if (!targetSel.value) targetSel.value = DEFAULT_TARGET_VALUE;
  state.target = parseTarget(targetSel.value || DEFAULT_TARGET_VALUE);
  await refreshKeyState();
}

const OUTPUT_TYPES = ['text', 'image', 'voice', 'video'] as const;

function isOutputType(v: string): v is AppState['outputType'] {
  return (OUTPUT_TYPES as readonly string[]).includes(v);
}

/** Reflect `state.outputType` into the pressed chip (the read path for the selection). */
function applyOutputType(): void {
  for (const c of Array.from(el('packs').children)) {
    c.setAttribute('aria-pressed', String(c.getAttribute('data-pack') === state.outputType));
  }
}

function wirePacks(): void {
  el('packs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.chip') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    // Consume the selection into state (previously this control was write-only:
    // it toggled aria-pressed but no code ever read the chosen pack).
    const pack = btn.getAttribute('data-pack') ?? 'text';
    if (isOutputType(pack)) state.outputType = pack;
    applyOutputType();
  });
}

function init(): void {
  wirePacks();
  el('analyzeBtn').addEventListener('click', () => onCapturePrimary());
  el('modeQuality').addEventListener('click', () => setMode('quality'));
  // Quality and Tool & agent are both selected on Capture and proceed via the
  // primary button — clicking the chip only switches mode (and relabels the CTA),
  // it no longer teleports the user mid-explore. MCP is a genuinely separate
  // off-pipeline screen, so its chip still navigates.
  el('modeTools').addEventListener('click', () => setMode('tools'));
  el('modeMcp').addEventListener('click', () => onMcpMode());
  el('loadExampleBtn').addEventListener('click', () => onLoadExample());
  el('nokeyOpenSettings').addEventListener('click', () => void openSettings());
  el('quickRunBtn').addEventListener('click', () => void onQuickRun());
  el('runCancelBtn').addEventListener('click', () => onCancelRun());
  el('grabBtn').addEventListener('click', () => void onGrab());
  el('buildBtn').addEventListener('click', () => openBuilder());
  el('builderBackBtn').addEventListener('click', () => show('capture'));
  el('builderSendBtn').addEventListener('click', () => void onBuilderSend());
  el('builderGenerateBtn').addEventListener('click', () => void onBuilderGenerate());
  el('builderUseBtn').addEventListener('click', () => onBuilderUse());
  el('builderInput').addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void onBuilderSend();
    }
  });
  el('builderLog').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.sugg') as HTMLElement | null;
    const fill = chip?.dataset['fill'];
    if (fill === undefined) return;
    const box = el('builderInput') as HTMLTextAreaElement;
    box.value = fill;
    box.focus();
  });
  el('versionPicker').addEventListener('change', () => onPickVersion());
  el('saveKey').addEventListener('click', () => void onSaveKey());
  el('settingsBtn').addEventListener('click', () => void openSettings());
  el('settingsClose').addEventListener('click', () => closeSettings());
  el('settingsModal').addEventListener('keydown', (e) => onSettingsKeydown(e as KeyboardEvent));
  el('saveSettings').addEventListener('click', () => void onSaveSettings());
  el('deleteKeys').addEventListener('click', () => void onDeleteKeys());
  el('loadModels').addEventListener('click', () => void onLoadModels());
  el('target').addEventListener('change', () => void refreshKeyState());
  el('toEvalPromptBtn').addEventListener('click', () => void onToEvalPrompt());
  el('epBackBtn').addEventListener('click', () => show('analyze'));
  el('epRegenBtn').addEventListener('click', () => void onRegenEvalPrompt());
  el('epCopyBtn').addEventListener('click', () => onCopyEvalPrompt());
  el('epContinueBtn').addEventListener('click', () => onEvalPromptContinue());
  el('addDimBtn').addEventListener('click', () => void onAddDimension());
  el('coverageBtn').addEventListener('click', () => void onCheckCoverage());
  el('evalPromptText').addEventListener('input', () => onEvalPromptEdited());
  el('dimensionList').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.dimchip') as HTMLElement | null;
    const name = chip?.dataset['name'];
    if (name) selectDimension(name);
  });
  el('analyzeBackBtn').addEventListener('click', () => goCapture());
  el('regenBtn').addEventListener('click', () => void showCases(true));
  el('moreCasesBtn').addEventListener('click', () => void onMoreCases());
  el('toolDefs').addEventListener('input', () => onToolDefsChanged());
  el('genToolCasesBtn').addEventListener('click', () => void onGenerateToolCases());
  el('addToolCaseBtn').addEventListener('click', () => void onAddToolCase());
  el('addScenarioBtn').addEventListener('click', () => void onAddScenario());
  el('casesBackBtn').addEventListener('click', () => show(state.mode === 'tools' ? 'capture' : 'evalprompt'));
  el('runBtn').addEventListener('click', () => void onRun());
  // Click a result row to expand its full detail (question · tools · response · why).
  el('resultsHost').addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.mrow') as HTMLElement | null;
    if (!row) return;
    const detail = row.nextElementSibling;
    if (detail?.classList.contains('mdetail')) {
      detail.classList.toggle('hidden');
      row.classList.toggle('open');
    }
  });
  el('resultsBackBtn').addEventListener('click', () => show('cases'));
  el('fixBtn').addEventListener('click', () => void onFixes());
  el('resultsVersionsBtn').addEventListener('click', () => void showVersions('results'));
  el('fixesBackBtn').addEventListener('click', () => show('results'));
  el('fixesVersionsBtn').addEventListener('click', () => void showVersions('fixes'));
  el('fixesEditBtn').addEventListener('click', () => void onApplyFixesAndEdit());
  el('compareA').addEventListener('change', () => renderAxisPair());
  el('compareB').addEventListener('change', () => renderAxisPair());
  el('versionsBackBtn').addEventListener('click', () => show(versionsReturnTo));
  el('versionsEditBtn').addEventListener('click', () => goCapture());
  el('exportMd').addEventListener('click', () => void exportReport('md'));
  el('exportJson').addEventListener('click', () => void exportReport('json'));
  el('casesHost').addEventListener('click', (e) => {
    const rm = (e.target as HTMLElement).closest('.rm') as HTMLElement | null;
    if (!rm) return;
    const i = Number(rm.dataset['i']);
    if (Number.isInteger(i)) {
      state.cases.splice(i, 1);
      persistSession();
      // Just re-render the (now shorter) list — removing a case must not trigger
      // case regeneration (which would wipe tool/agent cases or fail without a key).
      void renderCasesView();
    }
  });
  show('capture');
  initMcpPanel({ onBack: () => { setMode(state.mode); show('capture'); } });
  void (async () => {
    await applyDefaults();
    await restoreSession();
    await refreshVersionPicker();
  })();
}

init();
