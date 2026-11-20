/**
 * Gemini adapter (generateContent).
 *
 * Gemini takes the schema inline as `responseJsonSchema`, supports a seed,
 * and reports blocked prompts through `promptFeedback` rather than an error.
 */

import { GoogleGenAI, ApiError } from '@google/genai';
import type { ProviderConfig } from '@jander99/ai-review-review-contract';
import { redactSecret } from '@jander99/ai-review-review-contract';
import { LlmError } from '../errors';
import { parseAndCheck } from '../schema';
import { DEFAULT_MAX_TOKENS } from '../types';
import type { LlmClient, LlmRequest, LlmResult } from '../types';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

function mapError(error: unknown, apiKey: string): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  const message = redactSecret(error instanceof Error ? error.message : String(error), apiKey);
  const provider = 'gemini';
  if (error instanceof ApiError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return new LlmError('auth', message, provider, status);
    }
    if (status === 429) {
      return new LlmError('rate_limit', message, provider, status);
    }
    if (status === 400 && /context|token/i.test(message)) {
      return new LlmError('context_too_long', message, provider, status);
    }
    if (status >= 500) {
      return new LlmError('transient', message, provider, status);
    }
    return new LlmError('other', message, provider, status);
  }
  if (/fetch failed|network|ECONN|timeout|aborted/i.test(message)) {
    return new LlmError('transient', message, provider);
  }
  return new LlmError('other', message, provider);
}

export function createGeminiClient(config: ProviderConfig): LlmClient {
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    vertexai: false,
    httpOptions: {
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      timeout: config.timeoutMs ?? 120_000,
      // The Gemini SDK has no maxRetries; `attempts` counts the original request.
      retryOptions: { attempts: Number(config.options?.maxRetries ?? 3) + 1 },
    },
  });
  const maxInputTokens = Number(config.options?.maxInputTokens ?? 1_000_000);

  return {
    provider: 'gemini',
    capabilities: { supportsSeed: true, maxInputTokens },
    async complete<T = unknown>(req: LlmRequest): Promise<LlmResult<T>> {
      try {
        const response = await ai.models.generateContent({
          model: config.model,
          contents: req.prompt,
          config: {
            systemInstruction: req.system,
            responseMimeType: 'application/json',
            responseJsonSchema: req.jsonSchema as Record<string, unknown>,
            maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: 0,
            ...(req.seed === undefined ? {} : { seed: req.seed }),
          },
        });
        if (response.promptFeedback?.blockReason) {
          throw new LlmError('refusal', 'gemini blocked the prompt', 'gemini', undefined, response.promptFeedback.blockReason);
        }
        const candidate = response.candidates?.[0];
        if (candidate?.finishReason === 'SAFETY') {
          throw new LlmError('refusal', 'gemini stopped on safety', 'gemini');
        }
        const value = parseAndCheck(response.text ?? '', req.jsonSchema, 'gemini') as T;
        return {
          value,
          usage: {
            inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          },
        };
      } catch (error) {
        throw mapError(error, config.apiKey);
      }
    },
  };
}
