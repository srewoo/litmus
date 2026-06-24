/**
 * litmus side panel controller. Thin glue: holds step state, wires buttons, and
 * calls the unit-tested core/services. All HTML generation lives in views.ts; all
 * logic lives in the tested modules. Each Run saves a new version (the loop's spine).
 */
import { loadSettings, setKey, saveSettings, deleteAllKeys } from '../platform/storage';
import { chromeLocal, chromeSession } from '../platform/chromeStorage';
import { loadSnapshot, saveSnapshot } from '../platform/sessionCache';
import { mergeSettings } from './settingsForm';
import { IndexedDbStore } from '../platform/indexedDbStore';
import { getProvider } from '../providers';
import { fetchModels } from '../providers/listModels';
import type { ProviderId } from '../shared/types';
import { parseTarget } from './target';
import { buildWiring } from './providerDeps';
import { analyzePrompt } from '../services/analysis';
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
import { buildAxis } from '../core/litmusAxis';
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
  coverageHtml,
  rubricHealthHtml,
  band,
} from './views';
import type { VersionVM } from './views';
import type { EvalCase, PromptAnalysis, PromptVersion, TargetModel, ToolDef, ToolExpectation } from '../shared/types';
import { ToolDefSchema, ScenarioSchema } from '../shared/schema';
import { z } from 'zod';

const STEPS = ['capture', 'analyze', 'evalprompt', 'cases', 'run', 'results', 'fixes', 'versions'] as const;
type Step = (typeof STEPS)[number];

/** How many cases the first generation produces, and how many "+more" adds per click. */
const DEFAULT_CASE_COUNT = 12;
const MORE_CASE_COUNT = 10;
const TOOL_CASE_COUNT = 6;

const area = chromeLocal();
const session = chromeSession();
const store = new IndexedDbStore();

interface AppState {
  prompt: string;
  target: TargetModel;
  analysis: PromptAnalysis | null;
  dimensions: Dimension[];
  rubrics: Record<string, string>;
  activeDimension: string;
  /** What the user is testing: prompt output quality, or tool/agent behavior. */
  mode: 'quality' | 'tools';
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

function show(step: Step): void {
  for (const s of STEPS) el(`view-${s}`).classList.toggle('hidden', s !== step);
  const rail = el('rail').children;
  const idx = STEPS.indexOf(step);
  for (let i = 0; i < rail.length; i++) {
    (rail[i] as HTMLElement).className = i < idx ? 'done' : i === idx ? 'now' : '';
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
  el('keybox').classList.toggle('hidden', hasKey);
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
  el('analyzeBtn').textContent = mode === 'tools' ? 'Set up tool & agent tests →' : 'Analyze prompt →';
  persistSession();
}

/** The Capture primary button — routes by mode (rubric flow vs. straight to tests). */
function onCapturePrimary(): void {
  if (state.mode === 'tools') void onToToolTests();
  else void onAnalyze();
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
  setMessage('');
  const done = busy('coverageBtn', 'Checking…');
  try {
    const ctx = await wiring();
    const rows = await analyzeCoverage(state.prompt, state.dimensions.map((d) => d.name), suiteDeps(ctx));
    html('coverageHost', coverageHtml(rows));
    el('coverageHost').classList.remove('hidden');
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
  const est = estimateRun({
    caseCount: state.cases.length * Math.max(1, settings.samples),
    targetModel: target.model,
    judgeModel: w.auxModel,
    analyzerModel: w.auxModel,
    includeAnalysis: false,
    includeEvalGen: false,
    includeFixes: true,
    avgInputTokens: 600,
    avgOutputTokens: 400,
  });
  const over = exceedsCap(est, settings.spendCapUsd);
  el('costLine').textContent = `${formatUsd(est.estUsd)} · ${est.totalCalls} calls · cap ${formatUsd(settings.spendCapUsd)}`;
  (el('runBtn') as HTMLButtonElement).disabled = over;
  // Tool/agent mode tests tools, not text outputs — hide the text-case generators.
  const toolsMode = state.mode === 'tools';
  el('regenBtn').classList.toggle('hidden', toolsMode);
  el('moreCasesBtn').classList.toggle('hidden', toolsMode);
  el('agentPanel').classList.toggle('hidden', false);
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

async function onRun(): Promise<void> {
  setMessage('');
  if (state.cases.length === 0) {
    return setMessage(
      state.mode === 'tools' ? 'Add a tool test or agent scenario first.' : 'No cases to run — generate some first.',
      'error',
    );
  }
  show('run');
  try {
    const { settings, target, w } = await wiring();
    el('runStatus').textContent = `Running ${state.cases.length} cases on ${target.model}…`;
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
      ...(state.tools.length ? { tools: state.tools } : {}),
    });
    state.outcome = outcome;

    // Validate the rubric on this run (best-effort; extra judge calls).
    const combined = combineRubrics(state.rubrics) || undefined;
    state.rubricHealth = await validateRubric(state.prompt, state.cases, outcome.results, {
      provider: w.judgeProvider,
      apiKey: w.judgeKey,
      model: w.auxModel,
      rubric: combined,
    }).catch(() => null);

    const existing = await store.getVersions();
    const index = existing.length + 1;
    const prev = existing[existing.length - 1];
    // Truthful note: only call it "edited" when the prompt text actually changed.
    const note = index === 1 ? 'baseline' : prev && prev.text === state.prompt ? 're-run (no change)' : 'edited prompt';
    const version = {
      id: `v${index}`,
      index,
      text: state.prompt,
      note,
      parentId: state.lastVersionId,
      createdAt: Date.now(),
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
    setMessage(describeError(err), 'error');
    show('cases');
  }
}

function renderResults(versionIndex: number): void {
  const s = state.outcome!.summary;
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

async function showVersions(): Promise<void> {
  const versions = await store.getVersions();
  const runs = new Map<string, RunRecord | null>();
  const vms: VersionVM[] = [];
  let prev: number | null = null;
  for (const v of versions) {
    const run = await store.getRun(v.id);
    runs.set(v.id, run);
    const overall = run?.summary.overall ?? 0;
    vms.push({
      label: `v${v.index}`,
      note: v.note,
      overall,
      passLabel: run ? `${run.summary.passCount}/${run.summary.total}` : '—',
      avgSeconds: run ? round1(run.summary.speed.avgResponseMs / 1000) : 0,
      delta: prev === null ? null : round1(overall - prev),
      current: v.id === state.lastVersionId,
    });
    prev = overall;
  }
  html('versionsHost', versionsTimelineHtml(vms));

  // Litmus axis: compare the baseline version against the latest, by dimension.
  const first = versions[0];
  const last = versions[versions.length - 1];
  const firstDims = first ? runs.get(first.id)?.dimensions ?? [] : [];
  const lastDims = last ? runs.get(last.id)?.dimensions ?? [] : [];
  const axisWrap = el('axisWrap');
  if (versions.length >= 2 && firstDims.length > 0 && lastDims.length > 0) {
    html('axisHost', axisRowsHtml(buildAxis(firstDims, lastDims)));
    axisWrap.classList.remove('hidden');
  } else {
    axisWrap.classList.add('hidden');
  }
  show('versions');
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
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `v${v.index} · ${v.note}${score}`;
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
  setSettingsMsg('');
  el('settingsModal').classList.remove('hidden');
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
    });
    await saveSettings(area, next);
    // Rebuild the capture dropdown (it may now include a custom model) and apply the default.
    const targetSel = el('target') as HTMLSelectElement;
    fillTargetSelect(targetSel, next);
    targetSel.value = defaultValue(next);
    state.target = parseTarget(targetSel.value || DEFAULT_TARGET_VALUE);
    await refreshKeyState();
    el('settingsModal').classList.add('hidden');
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

function wirePacks(): void {
  el('packs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.chip') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    for (const c of Array.from(el('packs').children)) c.setAttribute('aria-pressed', String(c === btn));
  });
}

function init(): void {
  wirePacks();
  el('analyzeBtn').addEventListener('click', () => onCapturePrimary());
  el('modeQuality').addEventListener('click', () => setMode('quality'));
  el('modeTools').addEventListener('click', () => setMode('tools'));
  el('grabBtn').addEventListener('click', () => void onGrab());
  el('versionPicker').addEventListener('change', () => onPickVersion());
  el('saveKey').addEventListener('click', () => void onSaveKey());
  el('settingsBtn').addEventListener('click', () => void openSettings());
  el('settingsClose').addEventListener('click', () => el('settingsModal').classList.add('hidden'));
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
  el('resultsBackBtn').addEventListener('click', () => show('cases'));
  el('fixBtn').addEventListener('click', () => void onFixes());
  el('resultsVersionsBtn').addEventListener('click', () => void showVersions());
  el('fixesBackBtn').addEventListener('click', () => show('results'));
  el('fixesVersionsBtn').addEventListener('click', () => void showVersions());
  el('fixesEditBtn').addEventListener('click', () => void onApplyFixesAndEdit());
  el('versionsBackBtn').addEventListener('click', () => show('results'));
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
      void showCases(false);
    }
  });
  show('capture');
  void (async () => {
    await applyDefaults();
    await restoreSession();
    await refreshVersionPicker();
  })();
}

init();
