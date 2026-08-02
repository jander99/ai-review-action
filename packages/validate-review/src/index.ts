/**
 * Public API surface of `validate-review`. The bundle exports
 * `validateReview` so the root action can drive validation without
 * going through `@actions/core` I/O.
 */

export { parseValidatorResponse, validateReview } from './main';
export type { ValidateReviewOptions, ValidateReviewResult } from './main';