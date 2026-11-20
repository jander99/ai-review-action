/**
 * Anthropic adapter (Messages API).
 *
 * No sampling params: current models reject temperature/top_p/top_k, so the
 * body carries only what is needed. Structured output goes through
 * `output_config.format`, and the parsed reply is re-checked against the
 * schema.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { ProviderConfig } from '@jander99/ai-review-review-contract';
import { redactSecret } from '@jander99/ai-review-review-contract';
import { LlmError } from '../errors';
import { checkAgainstSchema } from '../schema';
import { DEFAULT_MAX_TOKENS } from '../types';
import type { LlmClient, LlmRequest, LlmResult } from '../types';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

function mapError(error: unknown, apiKey: string): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  const message = redactSecret(error instanceof Error ? error.message : String(error), apiKey);
  const provider = 'anthropic';
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new LlmError('auth', message, provider, error.status);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError('rate_limit', message, provider, error.status);
  }
  if (error instanceof Anthropic.BadRequestError) {
    const status = (error as { status?: number }).status;
    const tooLong = status === 413 || /prompt is too long|maximum context length|too many tokens/i.test(message);
    return new LlmError(tooLong ? 'context_too_long' : 'other', message, provider, status);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('transient', message, provider);
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new LlmError('transient', message, provider, error.status);
  }
  // messages.parse raises a base AnthropicError when the reply cannot be parsed
  // into the requested schema; that is invalid model output, not a transport fault.
  if (/parse structured output|not valid JSON/i.test(message)) {
    return new LlmError('invalid_output', message, provider);
  }
  return new LlmError('other', message, provider);
}

export function createAnthropicClient(config: ProviderConfig): LlmClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    authToken: null,
    baseURL: config.baseUrl ?? DEFAULT_BASE_URL,
    maxRetries: Number(config.options?.maxRetries ?? 3),
    timeout: config.timeoutMs ?? 120_000,
  });
  const maxInputTokens = Number(config.options?.maxInputTokens ?? 200_000);

  return {
    provider: 'anthropic',
    capabilities: { supportsSeed: false, maxInputTokens },
    async complete<T = unknown>(req: LlmRequest): Promise<LlmResult<T>> {
      try {
        const response = await client.messages.parse({
          model: config.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
          output_config: { format: jsonSchemaOutputFormat(req.jsonSchema as Parameters<typeof jsonSchemaOutputFormat>[0]) },
        });
        if (response.stop_reason === 'refusal') {
          throw new LlmError('refusal', 'anthropic refused the request', 'anthropic');
        }
        if (response.parsed_output === null || response.parsed_output === undefined) {
          throw new LlmError('invalid_output', 'anthropic returned no parsed output', 'anthropic');
        }
        const check = checkAgainstSchema(response.parsed_output, req.jsonSchema);
        if (!check.ok) {
          throw new LlmError('invalid_output', 'anthropic output does not match the expected schema', 'anthropic', undefined, check.errors);
        }
        return {
          value: response.parsed_output as T,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (error) {
        throw mapError(error, config.apiKey);
      }
    },
  };
}
