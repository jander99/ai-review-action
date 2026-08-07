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
  computeReviewDiff,
  REVIEW_DIFF_EXCLUDE_PATHSPECS,
  REVIEW_DIFF_MAX_BYTES,
  REVIEW_DIFF_EMPTY_PLACEHOLDER,
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

// Reviewer wrapper. Implemented by the root action's main loop;
// exported here so tests can drive the two-call retry path directly
// without going through `runReviews`.
export { invokeOpenCode } from './opencode';
export type { InvokeOpenCodeOptions, InvokeOpenCodeRuntime } from './opencode';

// Agent definition builder. Re-exported so tests can exercise the
// `__DIFF__` placeholder substitution without going through the full
// review pipeline.
export {
  buildAgentDefinition,
  buildValidatorAgentDefinition,
  getEventContext,
  titleOrRefForHeading,
} from './agent-definition';
export type { BuildAgentDefinitionOptions } from './agent-definition';
export type { EventContext } from './types';
