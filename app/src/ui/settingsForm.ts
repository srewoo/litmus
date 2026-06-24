/**
 * Pure merge of the settings-modal form into a validated Settings object.
 * Blank key fields are left untouched (so a saved key isn't wiped by an empty box);
 * other fields fall back to current values when not provided.
 */
import type { ProviderId, TargetModel } from '../shared/types';
import type { Settings } from '../shared/schema';
import { SettingsSchema } from '../shared/schema';

const PROVIDERS: readonly ProviderId[] = ['openai', 'anthropic', 'google'];

export interface SettingsForm {
  /** Raw key-field values; blank/whitespace entries are ignored. */
  readonly keys: Partial<Record<ProviderId, string>>;
  readonly defaultTarget?: TargetModel;
  /** '' clears the override (judge = target); a value sets it; undefined keeps current. */
  readonly judgeModel?: string;
  /** '' clears; a value sets; undefined keeps current. */
  readonly customModel?: string;
  readonly passThreshold?: number;
  readonly spendCapUsd?: number;
}

/** Empty string clears an optional field; undefined leaves it unchanged. */
function optional(formValue: string | undefined, current: string | undefined): string | undefined {
  if (formValue === undefined) return current;
  const trimmed = formValue.trim();
  return trimmed ? trimmed : undefined;
}

export function mergeSettings(current: Settings, form: SettingsForm): Settings {
  const keys: Partial<Record<ProviderId, string>> = { ...current.keys };
  for (const p of PROVIDERS) {
    const v = form.keys[p];
    if (v && v.trim()) keys[p] = v.trim();
  }
  return SettingsSchema.parse({
    keys,
    defaultTarget: form.defaultTarget ?? current.defaultTarget,
    judgeModel: optional(form.judgeModel, current.judgeModel),
    customModel: optional(form.customModel, current.customModel),
    availableModels: current.availableModels,
    passThreshold: form.passThreshold ?? current.passThreshold,
    spendCapUsd: form.spendCapUsd ?? current.spendCapUsd,
  });
}
