/**
 * Provider-neutral decision question and answer model.
 *
 * A adapter translates these onto the provider's own typed helpers; the
 * pipeline only ever sees this shape.
 */

import type { ProviderCapabilities } from '@jander99/ai-review-review-contract';

export type DecisionQuestion =
  | { readonly type: 'noul'; readonly text: string }
  | { readonly type: 'choice'; readonly text: string; readonly options: ReadonlyArray<string> }
  | { readonly type: 'score'; readonly text: string; readonly min: number; readonly max: number };

export type DecisionAnswer =
  | { readonly type: 'noul'; readonly pTrue: number }
  | { readonly type: 'choice'; readonly probabilities: Readonly<Record<string, number>> }
  | { readonly type: 'score'; readonly value: number };

export interface DecideRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

export interface DecideResult {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly usage: { readonly inputTokens: number };
}

export interface DecisionClient {
  readonly provider: string;
  readonly capabilities: ProviderCapabilities;
  decide(req: DecideRequest): Promise<DecideResult>;
}

export type DecisionClientFactory = (config: import('@jander99/ai-review-review-contract').ProviderConfig) => DecisionClient;
