/**
 * Shared LLM-provider error taxonomy.
 *
 * Every adapter maps its provider's errors onto these kinds so the pipeline
 * can react (retry, fail, report) without knowing the vendor.
 */

export type LlmErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'context_too_long'
  | 'refusal'
  | 'invalid_output'
  | 'transient'
  | 'other';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
