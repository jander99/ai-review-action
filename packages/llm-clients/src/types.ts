/**
 * LLM client interface.
 *
 * One narrow surface for "send a prompt, get schema-validated JSON back",
 * so the pipeline never knows which vendor answered.
 */

import type { ProviderCapabilities } from '@jander99/ai-review-review-contract';

export type JsonSchema = Readonly<Record<string, unknown>>;

export const DEFAULT_MAX_TOKENS = 4096;

export interface LlmRequest {
  readonly system: string;
  readonly prompt: string;
  readonly jsonSchema: JsonSchema;
  readonly seed?: number;
  readonly maxTokens?: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LlmResult<T = unknown> {
  readonly value: T;
  readonly usage: LlmUsage;
}

export interface LlmClient {
  readonly provider: string;
  readonly capabilities: ProviderCapabilities;
  complete<T = unknown>(req: LlmRequest): Promise<LlmResult<T>>;
}

export type LlmClientFactory = (config: ProviderConfig) => LlmClient;

import type { ProviderConfig } from '@jander99/ai-review-review-contract';
