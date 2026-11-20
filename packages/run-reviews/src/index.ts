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
  runReviews,
  computeReviewDiff,
  readBaseInstructions,
  REVIEW_DIFF_EXCLUDE_PATHSPECS,
  REVIEW_DIFF_MAX_BYTES,
  REPO_INSTRUCTION_FILES,
  REPO_INSTRUCTION_MAX_CHARS,
  DEFAULT_THRESHOLDS,
} from './main';
export type { RunReviewsOptions, RunReviewsResult } from './main';

// Diagnostics for rejected documents. Still used by the orchestration layer
// (Task 22 removes it together with the runtime modules).
export {
  buildRejectedDocumentPreview,
  REJECTED_DOCUMENT_CAP,
  REJECTED_DOCUMENT_PREVIEW_MAX_CHARS,
} from './rejected-document';
export type { RejectedDocument } from './rejected-document';

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

// Review runtime abstraction. The dispatcher in `./opencode.ts`
// picks between the two CLI implementations based on `RunReviewsOptions.tool`.
export { OpenCodeRuntime } from './opencode-run';
export { ClaudeCodeRuntime } from './claude-run';
export { runReview } from './runtime';
export type {
  DebugCapturePaths,
  ReviewRuntime,
  ReviewRuntimeOptions,
  ReviewRuntimeResult,
  ReviewRuntimeSpawn,
  ReviewTool,
} from './runtime';

// Back-compat: the validator package and existing tests still call
// `runOpenCodeRun` directly. The dispatcher (`invokeReview`) is the
// preferred entry point for new code.
export { runOpenCodeRun } from './opencode-run';
export type {
  OpenCodeRunRuntime,
  RunOpenCodeRunOptions,
  RunOpenCodeRunResult,
} from './opencode-run';
export { runClaudeRun } from './claude-run';
export type { RunClaudeRunOptions, RunClaudeRunResult } from './claude-run';

// Dispatcher + back-compat entry points. `invokeOpenCode` is kept as
// a thin wrapper around `invokeReview(..., 'opencode')` so any
// internal callers continue to work without modification. The wrapper
// also applies the two-call retry for the no-heading and format-invalid
// cases (see `./opencode.ts` for the retry details).
export { invokeReview, invokeOpenCode, formatReviewDocumentIssues } from './opencode';
export type {
  InvokeOpenCodeOptions,
  InvokeOpenCodeRuntime,
  InvokeReviewOptions,
} from './opencode';