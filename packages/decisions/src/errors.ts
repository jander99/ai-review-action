/**
 * Shared decision-provider error taxonomy.
 *
 * Every adapter maps its provider's errors onto these kinds so the pipeline
 * can react (retry, fail, report) without knowing the vendor.
 */

export type DecisionErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'context_too_long'
  | 'invalid_request'
  | 'transient'
  | 'other';

export class DecisionError extends Error {
  constructor(
    readonly kind: DecisionErrorKind,
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}
