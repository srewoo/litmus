/** Turn errors into a short, actionable panel message. Pure + testable. */
import { ProviderError } from '../providers/types';

export function describeError(err: unknown): string {
  if (err instanceof ProviderError) {
    let detail = err.detail;
    try {
      const parsed = JSON.parse(err.detail) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      /* detail wasn't JSON; use it as-is */
    }
    const hint =
      err.status === 400 || err.status === 404
        ? ' Pick a different model, or set a custom model in Settings.'
        : err.status === 401 || err.status === 403
          ? ' Check your API key in Settings.'
          : '';
    const which = err.model ? ` for model "${err.model}"` : '';
    return `${err.provider} rejected this${which} (HTTP ${err.status}): ${detail.slice(0, 160)}.${hint}`;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
