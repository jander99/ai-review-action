import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EventContext } from './types';

interface GitHubEvent {
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    base?: { ref?: string; sha?: string };
    head?: { ref?: string; sha?: string };
  };
  number?: number;
  ref?: string;
  before?: string;
  after?: string;
  inputs?: Record<string, unknown>;
}

const REVIEW_OUTPUT_DIRNAME = 'ai-review';

function buildReviewOutputPath(eventContext: EventContext): string {
  // The action is the authoritative source of the review file: the pipeline
  // produces the document, the action writes it here, and the publishing
  // step reads the same file. RUNNER_TEMP is provided by GitHub Actions and
  // is cleaned up after the job.
  const slug = eventContext.eventName === 'pull_request' ? 'pr' : 'push';
  const sha = (eventContext.headSha ?? eventContext.after ?? 'unknown').slice(0, 12);
  const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
  return path.join(runnerTemp, REVIEW_OUTPUT_DIRNAME, `review-${slug}-${sha}.md`);
}

function ensureReviewOutputDirExists(reviewOutputPath: string): void {
  // Runner-local and ephemeral; writable by the action's user only.
  const directory = path.dirname(reviewOutputPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

export function getEventContext(): EventContext {
  const eventName = process.env.GITHUB_EVENT_NAME || 'unknown';
  let event: GitHubEvent = {};

  if (process.env.GITHUB_EVENT_PATH) {
    event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) as GitHubEvent;
  }

  const context: EventContext = {
    eventName,
    repository: event.repository?.full_name || process.env.GITHUB_REPOSITORY,
  };

  if (eventName === 'pull_request') {
    context.prNumber = event.pull_request?.number ?? event.number;
    context.prTitle = event.pull_request?.title;
    context.prBody = event.pull_request?.body ?? undefined;
    context.baseRef = event.pull_request?.base?.ref || process.env.GITHUB_BASE_REF;
    context.headRef = event.pull_request?.head?.ref || process.env.GITHUB_HEAD_REF;
    context.baseSha = event.pull_request?.base?.sha;
    context.headSha = event.pull_request?.head?.sha || process.env.GITHUB_SHA;
  } else if (eventName === 'push') {
    context.ref = event.ref || process.env.GITHUB_REF;
    context.before = event.before;
    context.after = event.after || process.env.GITHUB_SHA;
  } else if (eventName === 'workflow_dispatch') {
    context.ref = event.ref || process.env.GITHUB_REF;
    context.inputs = event.inputs || {};
  }

  context.reviewOutputPath = buildReviewOutputPath(context);
  ensureReviewOutputDirExists(context.reviewOutputPath);

  return context;
}

export function titleOrRefForHeading(eventContext: EventContext): string {
  if (eventContext.eventName === 'pull_request') {
    return eventContext.prTitle ?? eventContext.headRef ?? `PR #${eventContext.prNumber ?? ''}`.trim();
  }
  return eventContext.ref ?? eventContext.headSha ?? 'review';
}
