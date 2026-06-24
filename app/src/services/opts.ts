/** Build ChatCallOptions from a service's deps. One place, no per-service branching. */
import type { ChatCallOptions, FetchLike } from '../providers/types';
import type { Clock } from '../core/stream';

export interface CallDeps {
  readonly apiKey: string;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export function chatOptions(deps: CallDeps): ChatCallOptions {
  return { apiKey: deps.apiKey, fetchImpl: deps.fetchImpl, clock: deps.clock, signal: deps.signal };
}
