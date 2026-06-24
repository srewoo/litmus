/**
 * Session-scoped cache of the expensive, regenerable artifacts (analysis, eval
 * prompt rubrics, and generated cases) plus the keys that gate their reuse.
 * Persisted to chrome.storage.session so it survives the side panel closing and
 * reopening within a browser session, and is wiped when the browser closes.
 * This is NOT durable version history (that lives in IndexedDB) — it only exists
 * to avoid repeating model calls while a session is alive.
 */
import type { StorageArea } from './storage';
import type { EvalCase, PromptAnalysis } from '../shared/types';
import type { Dimension } from '../services/dimensionExtract';

export interface SessionSnapshot {
  readonly prompt: string;
  /** The target select's "provider/model" value, so the choice is restored. */
  readonly targetValue: string;
  readonly analysis: PromptAnalysis | null;
  readonly dimensions: Dimension[];
  readonly rubrics: Record<string, string>;
  readonly activeDimension: string;
  readonly cases: EvalCase[];
  /** Keys gating reuse of the suite / cases; null when not yet generated. */
  readonly suiteKey: string | null;
  readonly casesKey: string | null;
}

const SNAPSHOT_KEY = 'litmus:session-cache';

/** Minimal shape guard — tolerate older/partial snapshots by returning null. */
function isSnapshot(v: unknown): v is SessionSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s['prompt'] === 'string' &&
    typeof s['targetValue'] === 'string' &&
    Array.isArray(s['dimensions']) &&
    Array.isArray(s['cases']) &&
    typeof s['rubrics'] === 'object' &&
    s['rubrics'] !== null
  );
}

export async function loadSnapshot(area: StorageArea): Promise<SessionSnapshot | null> {
  try {
    const raw = await area.get(SNAPSHOT_KEY);
    const val = raw[SNAPSHOT_KEY];
    return isSnapshot(val) ? val : null;
  } catch {
    return null;
  }
}

export async function saveSnapshot(area: StorageArea, snapshot: SessionSnapshot): Promise<void> {
  try {
    await area.set({ [SNAPSHOT_KEY]: snapshot });
  } catch {
    /* session storage is best-effort; never block the UI on it */
  }
}

export async function clearSnapshot(area: StorageArea): Promise<void> {
  try {
    await area.remove(SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}
