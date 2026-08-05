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
  buildValidatorConfig,
} from './config-builder';
export type {
  BuildMergedConfigOptions,
  BuildMergedConfigResult,
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

// Shared one-shot OpenCode CLI transport. The validator package uses this
// entry point so reviewer and validator invocations share process handling,
// NDJSON parsing, timeout enforcement, and debug capture.
export { runOpenCodeRun } from './opencode-run';
export type {
  DebugCapturePaths,
  OpenCodeRunRuntime,
  RunOpenCodeRunOptions,
  RunOpenCodeRunResult,
} from './opencode-run';
