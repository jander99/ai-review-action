import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  REVIEW_AGENT_PROMPT_TEMPLATE,
  SYNTHESIS_AGENT_PROMPT_TEMPLATE,
  VALIDATOR_AGENT_PROMPT_TEMPLATE,
} from '@jander99/ai-review-review-contract';
import type { AgentConfig, AgentDefinition, EventContext } from './types';

interface GitHubEvent {
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    title?: string;
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
  // The action is the authoritative source of the review file. The model
  // emits the structured review markdown in its reply; the action captures
  // the reply text, sanitizes it, validates it, and writes it to this
  // runner-local path so the structural validator and the publishing step
  // both read the same file. RUNNER_TEMP is provided by GitHub Actions and
  // is cleaned up after the job.
  const slug = eventContext.eventName === 'pull_request' ? 'pr' : 'push';
  const sha = (eventContext.headSha ?? eventContext.after ?? 'unknown').slice(0, 12);
  const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
  return path.join(runnerTemp, REVIEW_OUTPUT_DIRNAME, `review-${slug}-${sha}.md`);
}

function ensureReviewOutputDirExists(reviewOutputPath: string): void {
  // Create the directory so the action can write the review file directly.
  // The directory is runner-local and ephemeral; writable by the action's
  // user only.
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

function titleOrRefForHeading(eventContext: EventContext): string {
  if (eventContext.eventName === 'pull_request') {
    return eventContext.prTitle ?? eventContext.headRef ?? `PR #${eventContext.prNumber ?? ''}`.trim();
  }
  return eventContext.ref ?? eventContext.headSha ?? 'review';
}

export interface BuildAgentDefinitionOptions {
  eventContext: EventContext;
  priorReviewsBlock?: string | null;
}

export function buildAgentDefinition(options: BuildAgentDefinitionOptions): AgentDefinition {
  // Always resolve reviewOutputPath through the same path builder so the
  // runtime context serialized to the agent matches the value the action
  // will actually use.
  const eventContext = options.eventContext;
  const reviewOutputPath = eventContext.reviewOutputPath ?? buildReviewOutputPath(eventContext);
  const contextForAgent: EventContext = { ...eventContext, reviewOutputPath };
  const runtimeContext = JSON.stringify(contextForAgent, null, 2);
  const priorReviewsBlock = options.priorReviewsBlock ?? 'none';

  return {
    review: {
      description: 'Reviews repository changes using the supplied task prompt and GitHub event context.',
      mode: 'primary',
      prompt: REVIEW_AGENT_PROMPT_TEMPLATE
        .replace('__RUNTIME_CONTEXT__', runtimeContext)
        .replace('__PRIOR_REVIEWS__', priorReviewsBlock),
    },
    synthesis: {
      description: 'Synthesizes completed reviews into one canonical review document without inspecting the repository or using tools.',
      mode: 'primary',
      prompt: SYNTHESIS_AGENT_PROMPT_TEMPLATE,
    },
  };
}

/**
 * Build the validator-only agent definition. The prompt is a bare
 * `VALIDATOR_AGENT_PROMPT_TEMPLATE` with no runtime context, no
 * prior-reviews placeholder, and no path injection, so it is safe to
 * serialize into the validator-only config emitted via `config-json`.
 *
 * Callers must replace the `__REVIEW_PATH__` placeholder themselves
 * before the prompt is sent to OpenCode; the placeholder is left
 * intact here so the prompt remains a canonical template that
 * matches the shared contract.
 */
export function buildValidatorAgentDefinition(): AgentConfig {
  return {
    description: 'Validates the structural shape of a review markdown file.',
    mode: 'primary',
    prompt: VALIDATOR_AGENT_PROMPT_TEMPLATE,
  };
}

export { titleOrRefForHeading };