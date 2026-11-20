/**
 * `google` decision adapter on `@google/genai`'s Decisions API.
 *
 * Google differs from the systemone wire shape: `input` instead of `state`,
 * `x-goog-api-key` instead of a bearer header, and noul answers clamped to
 * 0.01–0.99 (passed through unchanged).
 */

import { GoogleGenAI, ApiError } from '@google/genai';
import type { ProviderConfig } from '@jander99/ai-review-review-contract';
import { redactSecret } from '@jander99/ai-review-review-contract';
import type { DecisionClient, DecideRequest, DecideResult, DecisionAnswer } from '../types';
import { DecisionError } from '../errors';
import { assertAnswersComplete } from '../answers';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const PROVIDER = 'google';

function mapError(err: unknown, config: ProviderConfig): DecisionError {
  if (err instanceof DecisionError) return err;
  const status = err instanceof ApiError ? err.status : (err as { status?: number } | null)?.status;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = redactSecret(rawMessage, config.apiKey);
  let kind: DecisionError['kind'] = 'other';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate_limit';
  else if (status === 413 || (status === 400 && /context|token length|too long/i.test(rawMessage))) kind = 'context_too_long';
  else if (status === 400 || status === 422) kind = 'invalid_request';
  else if ((status && status >= 500) || /connection|timed? ?out|fetch failed/i.test(rawMessage)) kind = 'transient';
  return new DecisionError(kind, message, PROVIDER, status);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Keep the timer referenced: an unref'd timer never fires when the raced
    // promise is the only other pending work, so the event loop drains first.
    timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function createGoogleDecisionClient(config: ProviderConfig): DecisionClient {
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      timeout: config.timeoutMs ?? 60_000,
    },
  });

  return {
    provider: PROVIDER,
    capabilities: {
      supportsSeed: false,
      maxInputTokens: Number(config.options?.maxInputTokens ?? 262_144),
    },
    async decide(req: DecideRequest): Promise<DecideResult> {
      const questions: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (q.type === 'noul') questions[id] = { type: 'noul', instructions: q.text };
        else if (q.type === 'choice') questions[id] = { type: 'choice', instructions: q.text, criteria: Object.fromEntries(q.options.map((o) => [o, ''])) };
        else {
          const levels = Array.from({ length: q.max - q.min + 1 }, (_, i) => String(q.min + i));
          questions[id] = { type: 'score', instructions: q.text, criteria: levels };
        }
      }

      const model = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
      try {
        const res = await withTimeout(
          ai.decisions.create({ model, input: req.state, questions: questions as never }, undefined, {
            // Per-call retry policy: httpOptions.retryOptions is ignored, and the
            // SDK default (5 attempts, 1s initial backoff) is too slow for tests.
            retries: { strategy: 'attempt-count-backoff', maxRetries: Number(config.options?.maxRetries ?? 3), backoff: { initialDelay: 0.05 } },
          }),
          config.timeoutMs ?? 60_000,
        );
        const answers: Record<string, DecisionAnswer> = {};
        for (const [id, raw] of Object.entries(res.answers ?? {}) as Array<[string, unknown]>) {
          const a = raw as { type: string; noul?: number; probabilities?: Record<string, number>; score?: number };
          if (a.type === 'noul') answers[id] = { type: 'noul', pTrue: a.noul ?? 0 };
          else if (a.type === 'choice') answers[id] = { type: 'choice', probabilities: a.probabilities ?? {} };
          else if (a.type === 'score') answers[id] = { type: 'score', value: a.score ?? 0 };
        }
        const result: DecideResult = { answers, usage: { inputTokens: res.usage?.total_input_tokens ?? 0 } };
        assertAnswersComplete(req, result, PROVIDER);
        return result;
      } catch (err) {
        throw mapError(err, config);
      }
    },
  };
}
