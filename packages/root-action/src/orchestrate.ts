/**
 * Root-action orchestration: read inputs, run the review, publish it.
 *
 * One module so the two entrypoints (`main.ts` for the bundle, `action-entry.ts`
 * for the leaf action) stay thin wrappers with only their own
 * `require.main === module` guard. Everything dispatchable lives in
 * `runWithDeps`, which takes its dependencies as an argument so tests can stub
 * them without touching the network.
 */

import * as core from '@actions/core';
import { context } from '@actions/github';
import {
  DEFAULT_THRESHOLDS,
  validateThresholds,
  type PolicyThresholds,
} from '@jander99/ai-review-review-contract';
import { listDecisionProviders } from '@jander99/ai-review-decisions';
import { listLlmProviders } from '@jander99/ai-review-llm-clients';
import { postCheckRun, type PostCheckRunOptions, type PostCheckRunResult } from '@jander99/ai-review-post-check-run';
import { postErrorComment, type PostErrorCommentOptions, type PostErrorCommentResult } from '@jander99/ai-review-post-error-comment';
import { postReview, type PostReviewOptions, type PostReviewResult, type ReviewEvent } from '@jander99/ai-review-post-comment';
import { runReviews, type RunReviewsOptions, type RunReviewsResult } from '@jander99/ai-review-run-reviews';

export { runReviews, postReview, postCheckRun, postErrorComment };

const DEFAULT_MAX_COMMENT_CHARS = 65_000;
const REVIEW_EVENTS: ReadonlyArray<ReviewEvent> = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];

export interface RunDeps {
  runReviews(options: RunReviewsOptions): Promise<RunReviewsResult>;
  postReview(
    options: PostReviewOptions,
    ctx: { owner: string; repo: string; pullNumber: number },
  ): Promise<PostReviewResult>;
  postCheckRun(options: PostCheckRunOptions): Promise<PostCheckRunResult>;
  postErrorComment(
    options: PostErrorCommentOptions,
    ctx: { owner: string; repo: string; issueNumber: number },
  ): Promise<PostErrorCommentResult>;
}

export const runDeps: RunDeps = { runReviews, postReview, postCheckRun, postErrorComment };

function requiredInput(name: string): string {
  const value = core.getInput(name);
  if (!value) {
    throw new Error(`missing required input: ${name}`);
  }
  return value;
}

function numberInput(name: string, fallback: number): number {
  const raw = core.getInput(name).trim();
  if (!raw) {
    return fallback;
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number (received '${raw}')`);
  }
  return value;
}

function booleanInput(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`Input does not meet boolean specification for '${name}': '${raw}'. Expected true|false.`);
}

function reviewEventInput(): ReviewEvent {
  const raw = (core.getInput('review-event') || 'COMMENT').trim().toUpperCase();
  const event = REVIEW_EVENTS.find((candidate) => candidate === raw);
  if (!event) {
    throw new Error(`review-event must be one of ${REVIEW_EVENTS.join(', ')} (received '${raw}')`);
  }
  return event;
}

function providerInput(name: string, known: ReadonlyArray<string>): string {
  const value = requiredInput(name);
  if (!known.includes(value)) {
    throw new Error(`${name} must be one of: ${known.join(', ')} (received '${value}')`);
  }
  return value;
}

/**
 * Every input the action reads, typed. Throws with the offending input's name
 * in the message so a workflow author can find it without reading this file.
 */
export function readActionInputs(): RunReviewsOptions & { reviewEvent: ReviewEvent } {
  const thresholds: PolicyThresholds = {
      keep: numberInput('keep-threshold', DEFAULT_THRESHOLDS.keep),
      drop: numberInput('drop-threshold', DEFAULT_THRESHOLDS.drop),
      severity: numberInput('severity-threshold', DEFAULT_THRESHOLDS.severity),
  };
  validateThresholds(thresholds);

  return {
    prompts: requiredInput('prompts'),
    llm: {
      provider: providerInput('llm-provider', listLlmProviders()),
      config: {
        baseUrl: core.getInput('llm-base-url') || undefined,
        apiKey: requiredInput('llm-api-key'),
        model: requiredInput('llm-model'),
      },
    },
    decision: {
      provider: providerInput('decision-provider', listDecisionProviders()),
      config: {
        baseUrl: core.getInput('decision-base-url') || undefined,
        apiKey: requiredInput('decision-api-key'),
        model: requiredInput('decision-model'),
      },
    },
    thresholds,
    githubToken: core.getInput('github-token') || process.env.GITHUB_TOKEN || undefined,
    reviewEvent: reviewEventInput(),
  };
}

interface PublishContext {
  readonly eventName: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly pullNumber: number;
  readonly githubToken: string;
  readonly maxCommentChars: number;
  readonly postComment: boolean;
  readonly postCheckRun: boolean;
  readonly checkName: string;
  readonly checkConclusion: string;
  readonly checkDetailsUrl: string;
}

function publishContext(githubToken: string): PublishContext {
  const issueNumber = context.issue.number;
  return {
    eventName: process.env.GITHUB_EVENT_NAME || '',
    owner: context.repo.owner,
    repo: context.repo.repo,
    issueNumber,
    pullNumber: issueNumber,
    githubToken,
    maxCommentChars: numberInput('max-comment-chars', DEFAULT_MAX_COMMENT_CHARS),
    postComment: booleanInput('post-comment', true),
    postCheckRun: booleanInput('post-check-run', true),
    checkName: core.getInput('check-name') || 'ai-review',
    checkConclusion: core.getInput('check-conclusion') || 'neutral',
    checkDetailsUrl: core.getInput('check-details-url') || 'https://github.com',
  };
}

const MISSING_TOKEN_WARNING =
  'github-token is not available; review and error comments/check-runs will not be published. Pass github-token: ${{ github.token }} to the action.';

/** Post a failure through the channel the event supports: PR comment, else check run. */
async function publishError(reason: string, deps: RunDeps, ctx: PublishContext): Promise<void> {
  core.setOutput('comment-url', '');
  core.setOutput('check-run-url', '');
  if (!reason) {
    return;
  }
  if (!ctx.githubToken) {
    core.warning(MISSING_TOKEN_WARNING);
    return;
  }
  if (ctx.eventName === 'pull_request' && ctx.postComment) {
    const result = await deps.postErrorComment(
      {
        token: ctx.githubToken,
        reason,
        postComment: ctx.postComment,
        maxChars: ctx.maxCommentChars,
        title: 'AI review failed.',
      },
      { owner: ctx.owner, repo: ctx.repo, issueNumber: ctx.issueNumber },
    );
    core.setOutput('comment-url', result.commentUrl);
  } else if (ctx.eventName !== 'pull_request' && ctx.postCheckRun) {
    const result = await deps.postCheckRun({
      token: ctx.githubToken,
      review: reason,
      name: ctx.checkName,
      conclusion: 'failure',
      detailsUrl: ctx.checkDetailsUrl,
      headSha: process.env.GITHUB_SHA ?? '',
      owner: ctx.owner,
      repo: ctx.repo,
    });
    core.setOutput('check-run-url', result.checkRunUrl);
  }
}

function writeReviewOutputs(result: RunReviewsResult): void {
  core.setOutput('review', result.review);
  core.setOutput('triage', result.triage);
  core.setOutput('review-output-path', result.reviewOutputPath);
  core.setOutput('findings-kept', result.counts.kept);
  core.setOutput('findings-uncertain', result.counts.uncertain);
  core.setOutput('findings-dropped', result.counts.dropped);
  core.setOutput(
    'tokens',
    JSON.stringify({
      llmInput: result.usage.llmInputTokens,
      llmOutput: result.usage.llmOutputTokens,
      decisionInput: result.usage.decisionInputTokens,
    }),
  );
  core.setOutput('failure-reason', result.failureReason);
}

/** Publish a successful review: inline review on a PR, check run otherwise. */
async function publishReview(
  result: RunReviewsResult,
  reviewEvent: ReviewEvent,
  deps: RunDeps,
  ctx: PublishContext,
): Promise<void> {
  core.setOutput('comment-url', '');
  core.setOutput('check-run-url', '');
  if (!ctx.githubToken) {
    core.warning(MISSING_TOKEN_WARNING);
    return;
  }
  if (ctx.eventName === 'pull_request') {
    const review = await deps.postReview(
      {
        token: ctx.githubToken,
        postComment: ctx.postComment,
        body: result.review,
        findings: result.kept,
        diff: result.diff,
        commitSha: result.headSha,
        // Only a completed review may approve or request changes.
        event: result.status === 'ok' ? reviewEvent : 'COMMENT',
        maxChars: ctx.maxCommentChars,
      },
      { owner: ctx.owner, repo: ctx.repo, pullNumber: ctx.pullNumber },
    );
    core.setOutput('comment-url', review.reviewUrl);
    return;
  }
  if (ctx.postCheckRun) {
    const check = await deps.postCheckRun({
      token: ctx.githubToken,
      review: result.review,
      name: ctx.checkName,
      // Nothing was found: a neutral conclusion keeps the check honest
      // instead of claiming success for a review that produced nothing.
      conclusion: result.status === 'no_findings_produced' ? 'neutral' : ctx.checkConclusion,
      detailsUrl: ctx.checkDetailsUrl,
      headSha: process.env.GITHUB_SHA ?? '',
      owner: ctx.owner,
      repo: ctx.repo,
    });
    core.setOutput('check-run-url', check.checkRunUrl);
  }
}

export async function runWithDeps(deps: RunDeps): Promise<void> {
  const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  if (!githubToken) {
    core.warning(MISSING_TOKEN_WARNING);
  }
  const ctx = publishContext(githubToken);

  // Keys are secrets the moment they are read; register them before any
  // error message could carry them into the log.
  const llmApiKey = core.getInput('llm-api-key');
  const decisionApiKey = core.getInput('decision-api-key');
  if (llmApiKey) core.setSecret(llmApiKey);
  if (decisionApiKey) core.setSecret(decisionApiKey);

  let inputs: ReturnType<typeof readActionInputs>;
  try {
    inputs = readActionInputs();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await publishError(reason, deps, ctx);
    core.setFailed(reason);
    return;
  }
  const { reviewEvent, ...reviewOptions } = inputs;

  const result = await deps.runReviews(reviewOptions);
  writeReviewOutputs(result);

  if (result.status === 'failed') {
    await publishError(result.failureReason, deps, ctx);
    core.setFailed(`Review failed: ${result.failureReason}`);
    return;
  }

  if (result.status === 'no_findings_produced') {
    core.warning('No findings produced: the proposer returned no valid findings after one retry.');
  }

  await publishReview(result, reviewEvent, deps, ctx);
}

export async function run(): Promise<void> {
  try {
    await runWithDeps(runDeps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `Root action failed: ${message}`;
    // Final backstop: a throw outside runWithDeps's own handling still
    // reaches the PR as an error comment / failing check run.
    try {
      await publishError(reason, runDeps, publishContext(core.getInput('github-token') || process.env.GITHUB_TOKEN || ''));
    } catch {
      // Publication is best effort; setFailed below is the authoritative signal.
    }
    core.setFailed(reason);
  }
}
