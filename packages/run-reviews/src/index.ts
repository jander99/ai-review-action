/**
 * Public API surface of `run-reviews`. Re-exports the programmatic
 * review pipeline and the testable config helpers so the root
 * action can wire the package end-to-end without going through
 * `@actions/core` I/O. The standalone action entrypoint lives in
 * `./action.ts`; importing this module never triggers side effects.
 */

export {
  buildMergedConfigObject,
  buildMergedConfig,
  buildFusionConfig,
  buildValidatorConfig,
} from './config-builder';
export type {
  BuildMergedConfigOptions,
  BuildMergedConfigResult,
  BuildFusionConfigOptions,
  BuildValidatorConfigOptions,
  BuildValidatorConfigResult,
} from './config-builder';

export {
  buildRejectedDocumentPreview,
  runReviews,
  REJECTED_DOCUMENT_CAP,
  REJECTED_DOCUMENT_PREVIEW_MAX_CHARS,
} from './main';
export type {
  RejectedDocument,
  RunReviewsOptions,
  RunReviewsResult,
} from './main';