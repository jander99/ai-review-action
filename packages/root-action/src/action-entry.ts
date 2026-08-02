/**
 * Repository-root action entrypoint.
 *
 * This file is the entrypoint for the repository-root `action.yml`'s
 * `main: dist/main.cjs`. It re-exports the package APIs so consumers
 * can call them directly and provides a thin `run()` function that
 * drives the pipeline the same way the leaf
 * `packages/root-action/dist/main.cjs` does.
 *
 * The repo-root `dist/main.cjs` is produced by esbuild from this file.
 * It exists so consumers can reference `owner/repo@v1` without
 * needing to know about the `packages/` subdirectory.
 */

import * as core from '@actions/core';
import { context } from '@actions/github';
import { runReviews } from '@jander99/ai-review-run-reviews';
import type { RunReviewsOptions, RunReviewsResult } from '@jander99/ai-review-run-reviews';
import { validateReview } from '@jander99/ai-review-validate-review';
import type { ValidateReviewOptions, ValidateReviewResult } from '@jander99/ai-review-validate-review';
import { postComment } from '@jander99/ai-review-post-comment';
import type { PostCommentOptions, PostCommentResult } from '@jander99/ai-review-post-comment';
import { postCheckRun } from '@jander99/ai-review-post-check-run';
import type { PostCheckRunOptions, PostCheckRunResult } from '@jander99/ai-review-post-check-run';
import { postErrorComment } from '@jander99/ai-review-post-error-comment';
import type { PostErrorCommentOptions, PostErrorCommentResult } from '@jander99/ai-review-post-error-comment';
import { DEFAULT_PERMISSION } from '@jander99/ai-review-run-reviews/permissions';

const DEFAULT_OPENCODE_VERSION = '1.18.5';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_TIMEOUT_MINUTES = 30;

// Empty RunReviewsResult used when runReviews throws. The run() flow
// converts any thrown error into a synthetic failure-reason so the
// orchestration can still post an error comment instead of silently
// failing.
const EMPTY_REVIEW_RESULT: RunReviewsResult = {
  review: '',
  reviewOutputPath: '',
  modelsUsed: '',
  cost: 0,
  costByModel: {},
  tokens: { input: 0, output: 0 },
  tokensByModel: {},
  configJson: '',
  effectiveModel: '',
  debugArtifactPath: '',
  failureReason: '',
};

function getBooleanInput(name: string, fallback = false): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === '') return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(
    `Input does not meet boolean specification for '${name}': '${raw}'. Expected true|false.`,
  );
}

function getIntInput(name: string, fallback: number): number {
  const raw = core.getInput(name).trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (received '${raw}')`);
  }
  return parsed;
}

function readPermissionInput(): typeof DEFAULT_PERMISSION {
  const raw = core.getInput('permission');
  if (!raw) return { ...DEFAULT_PERMISSION };
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('permission must be a JSON object');
  }
  return parsed as typeof DEFAULT_PERMISSION;
}

function roundCost(value: number): string {
  return (Math.round(value * 1e6) / 1e6).toString();
}

function buildRunReviewsOptions(): RunReviewsOptions {
  return {
    opencodeVersion: core.getInput('opencode-version') || DEFAULT_OPENCODE_VERSION,
    debug: getBooleanInput('debug'),
    model: core.getInput('model') || DEFAULT_MODEL,
    modelsInput: core.getInput('models'),
    fusionEnabled: getBooleanInput('fusion'),
    fusionModel: core.getInput('fusion-model'),
    failOnError: getBooleanInput('fail-on-error'),
    timeoutMinutes: getIntInput('timeout-minutes', DEFAULT_TIMEOUT_MINUTES),
    prompts: core.getInput('prompts'),
    permission: readPermissionInput(),
    userConfig: core.getInput('opencode-config') || undefined,
    githubToken: core.getInput('github-token') || process.env.GITHUB_TOKEN,
  };
}

function buildValidateReviewOptions(reviewPath: string, model: string, passedConfigJson: string): ValidateReviewOptions {
  return {
    opencodeVersion: core.getInput('opencode-version') || DEFAULT_OPENCODE_VERSION,
    reviewPath,
    model,
    timeoutMinutes: 5,
    passedConfigJson,
  };
}

function buildPostCommentOptions(review: string, maxChars: number): PostCommentOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    review,
    postComment: getBooleanInput('post-comment', true),
    maxChars,
  };
}

function buildPostCheckRunOptions(review: string, name: string, conclusion: string, detailsUrl: string): PostCheckRunOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    review,
    name,
    conclusion,
    detailsUrl,
    headSha: process.env.GITHUB_SHA ?? '',
    owner: context.repo.owner,
    repo: context.repo.repo,
  };
}

function buildPostErrorCommentOptions(reason: string, maxChars: number): PostErrorCommentOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    reason,
    postComment: getBooleanInput('post-comment', true),
    maxChars,
    title: 'AI Review validator rejected the generated review.',
  };
}

/**
 * Compute the canonical failure-reason string. See main.ts for the
 * rationale.
 */
function computeFailureReason(reviewerFailureReason: string, validatorFailureReason: string): string {
  if (reviewerFailureReason) return reviewerFailureReason;
  if (validatorFailureReason) return `Validator: ${validatorFailureReason}`;
  return '';
}

/**
 * Build a synthetic invalid validation result when the validator
 * invocation throws. Mirrors packages/root-action/src/main.ts.
 */
function buildSyntheticInvalidValidation(message: string, prefix: string): ValidateReviewResult {
  return {
    status: 'invalid',
    reason: message,
    cost: 0,
    tokens: { input: 0, output: 0 },
    failureReason: `${prefix}: ${message}`,
  };
}

/**
 * Mutable dependency bag for the orchestration. Mirrors
 * packages/root-action/src/main.ts so both bundles expose the same
 * surface for tests and downstream consumers.
 */
export interface RunDeps {
  runReviews(options: RunReviewsOptions): Promise<RunReviewsResult>;
  validateReview(options: ValidateReviewOptions): Promise<ValidateReviewResult>;
  postComment(
    options: PostCommentOptions,
    ctx: { owner: string; repo: string; issueNumber: number },
  ): Promise<PostCommentResult>;
  postCheckRun(options: PostCheckRunOptions): Promise<PostCheckRunResult>;
  postErrorComment(
    options: PostErrorCommentOptions,
    ctx: { owner: string; repo: string; issueNumber: number },
  ): Promise<PostErrorCommentResult>;
}

export const runDeps: RunDeps = {
  runReviews,
  validateReview,
  postComment,
  postCheckRun,
  postErrorComment,
};

interface PublishContext {
  eventName: string;
  owner: string;
  repo: string;
  issueNumber: number;
  maxCommentChars: number;
  postCommentEnabled: boolean;
  postCheckRunEnabled: boolean;
  checkName: string;
  checkDetailsUrl: string;
}

function buildPublishContext(): PublishContext {
  return {
    eventName: process.env.GITHUB_EVENT_NAME || '',
    owner: context.repo.owner,
    repo: context.repo.repo,
    issueNumber: context.issue.number,
    maxCommentChars: getIntInput('max-comment-chars', 65000),
    postCommentEnabled: getBooleanInput('post-comment', true),
    postCheckRunEnabled: getBooleanInput('post-check-run', true),
    checkName: core.getInput('check-name') || 'ai-review',
    checkDetailsUrl: core.getInput('check-details-url') || 'https://github.com',
  };
}

/**
 * Post an event-aware error comment / failure check run. Mirrors
 * packages/root-action/src/main.ts; kept in sync so both bundles
 * share the same publication semantics.
 */
async function publishError(reason: string, deps: RunDeps, ctx: PublishContext): Promise<void> {
  core.setOutput('comment-url', '');
  core.setOutput('check-run-url', '');

  if (!reason) return;

  if (ctx.eventName === 'pull_request' && ctx.postCommentEnabled) {
    const commentResult: PostErrorCommentResult = await deps.postErrorComment(
      buildPostErrorCommentOptions(reason, ctx.maxCommentChars),
      {
        owner: ctx.owner,
        repo: ctx.repo,
        issueNumber: ctx.issueNumber,
      },
    );
    core.setOutput('comment-url', commentResult.commentUrl);
  } else if (ctx.eventName !== 'pull_request' && ctx.postCheckRunEnabled) {
    const checkResult: PostCheckRunResult = await deps.postCheckRun(
      buildPostCheckRunOptions(reason, ctx.checkName, 'failure', ctx.checkDetailsUrl),
    );
    core.setOutput('check-run-url', checkResult.checkRunUrl);
  }
}

/**
 * Programmatic orchestration entrypoint. Same flow as `run()` but
 * with the package APIs injected through `deps`. The default `run()`
 * entrypoint delegates here with the bundled `runDeps`.
 *
 * Every failure path (reviewer throw, reviewer invalid, validator
 * throw, validator invalid, all invalid) routes through
 * `publishError`. The entrypoint's `.catch` (in `run()`) is the
 * final backstop and also calls `publishError`.
 */
export async function runWithDeps(deps: RunDeps): Promise<void> {
  const publishCtx = buildPublishContext();
  const checkConclusion = core.getInput('check-conclusion') || 'neutral';
  const failOnError = getBooleanInput('fail-on-error');

  // 1. Run reviews. Catch any thrown error and convert it into a
  // synthetic failure-reason so the existing publish-error logic
  // still fires (previously the throw propagated past the catch
  // in `run()` and only `core.setFailed` ran, leaving the PR with
  // a red step but no error comment).
  const reviewOptions = buildRunReviewsOptions();
  let reviewResult: RunReviewsResult;
  try {
    reviewResult = await deps.runReviews(reviewOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reviewResult = { ...EMPTY_REVIEW_RESULT, failureReason: `Review invocation threw: ${message}` };
  }

  core.setOutput('review', reviewResult.review);
  core.setOutput('review-output-path', reviewResult.reviewOutputPath);
  core.setOutput('models-used', reviewResult.modelsUsed);
  core.setOutput('cost', reviewResult.cost);
  core.setOutput('cost-by-model', JSON.stringify(reviewResult.costByModel));
  core.setOutput('tokens', JSON.stringify(reviewResult.tokens));
  core.setOutput('tokens-by-model', JSON.stringify(reviewResult.tokensByModel));
  core.setOutput('effective-model', reviewResult.effectiveModel);
  core.setOutput('config-json', reviewResult.configJson);
  if (reviewResult.debugArtifactPath) {
    core.setOutput('debug-artifact-path', reviewResult.debugArtifactPath);
  }

  let validation: ValidateReviewResult | null = null;
  if (reviewResult.review) {
    try {
      validation = await deps.validateReview(
        buildValidateReviewOptions(
          reviewResult.reviewOutputPath,
          reviewResult.effectiveModel || reviewOptions.model,
          reviewResult.configJson,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      validation = buildSyntheticInvalidValidation(message, 'Validator invocation threw');
    }
    core.setOutput('validate-status', validation.status);
    core.setOutput('validate-reason', validation.reason);
    core.setOutput('validate-cost', validation.cost);
    core.setOutput('validate-tokens', JSON.stringify(validation.tokens));
  } else {
    core.setOutput('validate-status', '');
    core.setOutput('validate-reason', '');
    core.setOutput('validate-cost', 0);
    core.setOutput('validate-tokens', JSON.stringify({ input: 0, output: 0 }));
  }

  const totalCost = reviewResult.cost + (validation?.cost ?? 0);
  core.setOutput('total-cost', totalCost);
  core.info(`total-cost=${roundCost(totalCost)}`);

  const failureReason = computeFailureReason(
    reviewResult.failureReason,
    validation?.failureReason ?? '',
  );
  core.setOutput('failure-reason', failureReason);

  const reviewerFailureReason = reviewResult.failureReason;
  const errorReason =
    validation?.reason ||
    (reviewerFailureReason ? `review failed before producing a document: ${reviewerFailureReason}` : '');
  const validationInvalid = validation?.status === 'invalid';
  const runFailed = !reviewResult.review && Boolean(reviewerFailureReason);
  const shouldPublishError = validationInvalid || runFailed;

  if (!shouldPublishError && reviewResult.review) {
    core.setOutput('comment-url', '');
    core.setOutput('check-run-url', '');
    if (publishCtx.eventName === 'pull_request' && publishCtx.postCommentEnabled) {
      const commentResult: PostCommentResult = await deps.postComment(
        buildPostCommentOptions(reviewResult.review, publishCtx.maxCommentChars),
        {
          owner: publishCtx.owner,
          repo: publishCtx.repo,
          issueNumber: publishCtx.issueNumber,
        },
      );
      core.setOutput('comment-url', commentResult.commentUrl);
    } else if (publishCtx.eventName !== 'pull_request' && publishCtx.postCheckRunEnabled) {
      const checkResult: PostCheckRunResult = await deps.postCheckRun(
        buildPostCheckRunOptions(
          reviewResult.review,
          publishCtx.checkName,
          checkConclusion,
          publishCtx.checkDetailsUrl,
        ),
      );
      core.setOutput('check-run-url', checkResult.checkRunUrl);
    }
  } else if (shouldPublishError && errorReason) {
    await publishError(errorReason, deps, publishCtx);
  } else {
    core.setOutput('comment-url', '');
    core.setOutput('check-run-url', '');
  }

  const hasFailure = Boolean(reviewerFailureReason) || validationInvalid || runFailed;
  if (hasFailure) {
    const finalMessage = reviewerFailureReason
      ? `Review failed: ${reviewerFailureReason}`
      : `Review validation failed: ${validation?.reason || 'unspecified'}`;
    core.setFailed(finalMessage);
  } else if (failOnError && reviewerFailureReason) {
    core.setFailed(reviewerFailureReason);
  }
}

export async function run(): Promise<void> {
  return runWithDeps(runDeps);
}

if (require.main === module) {
  run().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `Root action failed: ${message}`;
    // Best-effort: also post an error comment / failure check run.
    try {
      const publishCtx = buildPublishContext();
      await publishError(reason, runDeps, publishCtx);
    } catch {
      // Ignore publication errors here; `core.setFailed` below is
      // the authoritative failure signal.
    }
    core.setFailed(reason);
  });
}

export {
  runReviews,
  validateReview,
  postComment,
  postCheckRun,
  postErrorComment,
  computeFailureReason,
};
export type {
  RunReviewsOptions,
  RunReviewsResult,
  ValidateReviewOptions,
  ValidateReviewResult,
  PostCommentOptions,
  PostCommentResult,
  PostCheckRunOptions,
  PostCheckRunResult,
  PostErrorCommentOptions,
  PostErrorCommentResult,
};