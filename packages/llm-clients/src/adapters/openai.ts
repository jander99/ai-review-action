/**
 * OpenAI adapter (Responses API).
 *
 * Structured output is requested with a strict JSON schema, then the reply
 * is re-checked by `parseAndCheck` — the schema is a request, not a promise.
 */

import OpenAI from 'openai';
import type { ProviderConfig } from '@jander99/ai-review-review-contract';
import { redactSecret } from '@jander99/ai-review-review-contract';
import { LlmError } from '../errors';
import { parseAndCheck } from '../schema';
import { DEFAULT_MAX_TOKENS } from '../types';
import type { LlmClient, LlmRequest, LlmResult } from '../types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function mapError(error: unknown, apiKey: string): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  const message = redactSecret(error instanceof Error ? error.message : String(error), apiKey);
  const provider = 'openai';
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new LlmError('auth', message, provider, error.status);
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new LlmError('rate_limit', message, provider, error.status);
  }
  if (error instanceof OpenAI.BadRequestError) {
    const code = (error as { code?: string }).code;
    return new LlmError(code === 'context_length_exceeded' ? 'context_too_long' : 'other', message, provider, error.status);
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmError('transient', message, provider);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new LlmError('transient', message, provider);
  }
  if (error instanceof OpenAI.InternalServerError) {
    return new LlmError('transient', message, provider, error.status);
  }
  return new LlmError('other', message, provider);
}

export function createOpenAiClient(config: ProviderConfig): LlmClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl ?? DEFAULT_BASE_URL,
    maxRetries: Number(config.options?.maxRetries ?? 3),
    timeout: config.timeoutMs ?? 120_000,
  });
  const maxInputTokens = Number(config.options?.maxInputTokens ?? 128_000);
  const effort = config.options?.reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' | undefined;

  return {
    provider: 'openai',
    capabilities: { supportsSeed: false, maxInputTokens },
    async complete<T = unknown>(req: LlmRequest): Promise<LlmResult<T>> {
      try {
        const response = await client.responses.create({
          model: config.model,
          instructions: req.system,
          input: req.prompt,
          max_output_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          store: false,
          ...(effort ? { reasoning: { effort } } : {}),
          text: {
            format: {
              type: 'json_schema',
              name: 'review_output',
              schema: req.jsonSchema as Record<string, unknown>,
              strict: true,
            },
          },
        });
        for (const item of response.output) {
          if (item.type === 'message') {
            for (const part of item.content) {
              if (part.type === 'refusal') {
                throw new LlmError('refusal', 'openai refused the request', 'openai', undefined, part.refusal);
              }
            }
          }
        }
        const value = parseAndCheck(response.output_text, req.jsonSchema, 'openai') as T;
        return {
          value,
          usage: {
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
          },
        };
      } catch (error) {
        throw mapError(error, config.apiKey);
      }
    },
  };
}
