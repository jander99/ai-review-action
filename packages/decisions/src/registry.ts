/**
 * Provider registry: provider id → factory.
 *
 * The action validates its `decision-provider` input against these keys, so
 * the allowed list and the error message come from code, not docs.
 */

import type { ProviderConfig } from '@jander99/ai-review-review-contract';
import type { DecisionClient, DecisionClientFactory } from './types';
import { DecisionError } from './errors';

const factories: Record<string, DecisionClientFactory> = {};

export function registerDecisionProvider(provider: string, factory: DecisionClientFactory): void {
  factories[provider] = factory;
}

export function listDecisionProviders(): string[] {
  return Object.keys(factories).sort();
}

export function createDecisionClient(provider: string, config: ProviderConfig): DecisionClient {
  const factory = factories[provider];
  if (!factory) {
    throw new DecisionError('invalid_request', `decision-provider must be one of: ${listDecisionProviders().join(', ')} (received '${provider}')`, provider);
  }
  if (!config.apiKey) {
    throw new DecisionError('invalid_request', 'decision-api-key is required', provider);
  }
  if (!config.model) {
    throw new DecisionError('invalid_request', 'decision-model is required', provider);
  }
  return factory(config);
}
