/**
 * Provider registry: provider id → factory.
 *
 * The action validates its `llm-provider` input against these keys, so
 * the allowed list and the error message come from code, not docs.
 */

import type { ProviderConfig } from '@jander99/ai-review-review-contract';
import type { LlmClient, LlmClientFactory } from './types';
import { LlmError } from './errors';

const factories: Record<string, LlmClientFactory> = {};

export function registerLlmProvider(provider: string, factory: LlmClientFactory): void {
  factories[provider] = factory;
}

export function listLlmProviders(): string[] {
  return Object.keys(factories).sort();
}

export function createLlmClient(provider: string, config: ProviderConfig): LlmClient {
  const factory = factories[provider];
  if (!factory) {
    throw new LlmError('other', `llm-provider must be one of: ${listLlmProviders().join(', ')} (received '${provider}')`, provider);
  }
  if (!config.apiKey) {
    throw new LlmError('other', 'llm-api-key is required', provider);
  }
  if (!config.model) {
    throw new LlmError('other', 'llm-model is required', provider);
  }
  return factory(config);
}
