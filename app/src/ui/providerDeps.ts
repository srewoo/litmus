/**
 * Build the provider wiring for a run from settings + target.
 *
 * The judge defaults to the SAME model as the target — guaranteed callable if the
 * target is (avoids 404s from a model the user's key can't access). A distinct
 * judge can be set explicitly in settings (PRD §8.7 self-preference note).
 */
import type { Settings } from '../shared/schema';
import type { ProviderId, TargetModel } from '../shared/types';
import type { Provider } from '../providers/types';

export interface LoopWiring {
  readonly targetProvider: Provider;
  readonly targetKey: string;
  readonly judgeProvider: Provider;
  readonly judgeKey: string;
  readonly auxModel: string;
}

/**
 * Resolve the judge/aux model: an explicit override, else the target model.
 * Strips any leading "provider/" (legacy stored values), and falls back to the
 * target model if the override isn't among the target provider's known models
 * (auto-heals a stale or cross-provider override).
 */
export function resolveJudgeModel(settings: Settings, target: TargetModel): string {
  const raw = settings.judgeModel?.trim();
  if (!raw) return target.model;
  const id = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
  if (!id) return target.model;
  const known = settings.availableModels?.[target.provider];
  if (known && known.length > 0 && !known.includes(id)) return target.model;
  return id;
}

export function buildWiring(
  settings: Settings,
  target: TargetModel,
  factory: (id: ProviderId) => Provider,
): LoopWiring {
  const key = settings.keys[target.provider];
  if (!key) throw new Error(`Add your ${target.provider} key first (Settings → API keys).`);
  const provider = factory(target.provider);
  return {
    targetProvider: provider,
    targetKey: key,
    judgeProvider: provider,
    judgeKey: key,
    auxModel: resolveJudgeModel(settings, target),
  };
}
