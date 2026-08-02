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

// Shared OpenCode HTTP server transport. Exported so the
// `validate-review` package can drive its validator call through the
// same transport that fixes the run-reviews capture race, without
// duplicating the lifecycle, password handling, or response parsing.
export {
  runOpenCodeServer,
  selectTerminalText,
} from './opencode-server';
export type {
  DebugCapturePaths,
  OpenCodeServerRuntime,
  RunOpenCodeServerOptions,
  RunOpenCodeServerResult,
} from './opencode-server';