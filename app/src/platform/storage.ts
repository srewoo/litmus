/**
 * Settings + key persistence over an injectable StorageArea (so it's testable
 * without chrome.*). In the extension this wraps chrome.storage.local; keys never
 * leave the browser (PRD §13).
 */
import type { ProviderId } from '../shared/types';
import type { Settings } from '../shared/schema';
import { SettingsSchema } from '../shared/schema';

export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const SETTINGS_KEY = 'litmus:settings';

export async function loadSettings(area: StorageArea): Promise<Settings> {
  const raw = await area.get(SETTINGS_KEY);
  // This store holds the user's API keys; throwing on corrupt or schema-drifted
  // persisted JSON would hard-brick the panel. Fall back to defaults instead so
  // the panel always loads (P1). Valid data is unaffected.
  const result = SettingsSchema.safeParse(raw[SETTINGS_KEY] ?? {});
  if (result.success) return result.data;
  console.warn('litmus: stored settings failed validation; falling back to defaults', result.error);
  return SettingsSchema.parse({});
}

export async function saveSettings(area: StorageArea, settings: Settings): Promise<void> {
  await area.set({ [SETTINGS_KEY]: SettingsSchema.parse(settings) });
}

export async function setKey(area: StorageArea, provider: ProviderId, key: string): Promise<Settings> {
  const current = await loadSettings(area);
  const next = SettingsSchema.parse({ ...current, keys: { ...current.keys, [provider]: key } });
  await saveSettings(area, next);
  return next;
}

export async function getKey(area: StorageArea, provider: ProviderId): Promise<string | undefined> {
  const settings = await loadSettings(area);
  return settings.keys[provider];
}

export async function deleteAllKeys(area: StorageArea): Promise<Settings> {
  const current = await loadSettings(area);
  const next = SettingsSchema.parse({ ...current, keys: {} });
  await saveSettings(area, next);
  return next;
}
