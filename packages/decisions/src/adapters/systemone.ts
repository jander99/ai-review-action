/**
 * `systemone` decision adapter — one wire shape for TypeSafe and SubQ.
 *
 * Both providers speak `POST <baseURL>/v1/systemone` with a bearer key, so
 * SubQ is configuration (`baseUrl: https://api.subq.ai`), not a second
 * adapter. Google needs its own (see google.ts).
 */

import {
  TypeSafeClient,
  noul,
  choice,
} from '@typesafe-ai/sdk';
import type { ProviderConfig } from '@jander99/ai-review-review-contract';
import { redactSecret } from '@jander99/ai-review-review-contract';
import type { DecisionClient, DecideRequest, DecideResult, DecisionAnswer } from '../types';
import { DecisionError } from '../errors';
import { assertAnswersComplete } from '../answers';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const PROVIDER = 'systemone';

function mapError(err: unknown, config: ProviderConfig): DecisionError {
  if (err instanceof DecisionError) return err;
  const status = (err as { status?: number } | null)?.status;
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

export function createSystemOneClient(config: ProviderConfig): DecisionClient {
  const client = new TypeSafeClient({
    apiKey: config.apiKey,
    baseURL: config.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: config.model,
    timeout: config.timeoutMs ?? 60_000,
    retry: { maxRetries: Number(config.options?.maxRetries ?? 3) },
    compression: false,
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
        if (q.type === 'noul') questions[id] = noul(q.text);
        else if (q.type === 'choice') questions[id] = choice(q.text, Object.fromEntries(q.options.map((o) => [o, null])));
        else questions[id] = { type: 'score', instructions: q.text, criteria: Array.from({ length: q.max - q.min + 1 }, (_, i) => String(q.min + i)) };
      }

      try {
        const res = await client.systemOne({ state: req.state, questions: questions as never });
        const answers: Record<string, DecisionAnswer> = {};
        for (const [id, raw] of Object.entries(res.answers ?? {}) as Array<[string, unknown]>) {
          const a = raw as { type: string; noul?: number; probabilities?: Record<string, number>; score?: number };
          if (a.type === 'noul') answers[id] = { type: 'noul', pTrue: a.noul ?? 0 };
          else if (a.type === 'choice') answers[id] = { type: 'choice', probabilities: a.probabilities ?? {} };
          else if (a.type === 'score') answers[id] = { type: 'score', value: a.score ?? 0 };
        }
        const result: DecideResult = { answers, usage: { inputTokens: res.usage?.input_tokens ?? 0 } };
        assertAnswersComplete(req, result, PROVIDER);
        return result;
      } catch (err) {
        throw mapError(err, config);
      }
    },
  };
}
