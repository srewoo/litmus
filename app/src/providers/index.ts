/** Provider barrel + registry. */
import type { Provider } from './types';
import type { ProviderId } from '../shared/types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GoogleProvider } from './google';

export { OpenAIProvider } from './openai';
export { AnthropicProvider } from './anthropic';
export { GoogleProvider } from './google';
export { ProviderError } from './types';
export type { Provider, ChatMessage, ChatRequest, ChatResponse, ChatCallOptions } from './types';

/** Resolve a Provider by id. */
export function getProvider(id: ProviderId): Provider {
  switch (id) {
    case 'openai':
      return new OpenAIProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'google':
      return new GoogleProvider();
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown provider ${String(exhaustive)}`);
    }
  }
}
