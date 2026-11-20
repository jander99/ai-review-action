/**
 * Public API surface of `run-reviews`. Re-exports the event context and the
 * decision-review pipeline entry point so the root action can wire the
 * package end-to-end without going through `@actions/core` I/O. The
 * standalone action entrypoint lives in `./action.ts`; importing this module
 * never triggers side effects.
 */

export {
  runReviews,
  computeReviewDiff,
  readBaseInstructions,
  REVIEW_DIFF_EXCLUDE_PATHSPECS,
  REVIEW_DIFF_MAX_BYTES,
  REPO_INSTRUCTION_FILES,
  REPO_INSTRUCTION_MAX_CHARS,
  CONTEXT_FILE_MAX_BYTES,
  DEFAULT_THRESHOLDS,
} from './main';
export type { RunReviewsOptions, RunReviewsResult } from './main';

export { getEventContext, titleOrRefForHeading } from './event-context';
export type { EventContext } from './types';

export { parsePrompts } from './prompt-composer';
