/**
 * `runReviews`: the action's review step on the decision-API pipeline.
 *
 * Gathers the event, diff, file context and base-branch instructions, then
 * delegates all judgement to `runReviewPipeline`. Everything here is I/O and
 * wiring; the pipeline stays pure.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_THRESHOLDS,
  parseUnifiedDiff,
  validateThresholds,
  type PolicyThresholds,
  type PostableFinding,
  type PriorFinding,
  type ProviderConfig,
} from '@jander99/ai-review-review-contract';
import { createDecisionClient, type DecisionClient } from '@jander99/ai-review-decisions';
import { createLlmClient, type LlmClient } from '@jander99/ai-review-llm-clients';
import { fetchPriorReviews } from '@jander99/ai-review-previous-reviews';
import {
  runReviewPipeline,
  type ContextFile,
  type PipelineStatus,
  type ReviewPipelineResult,
} from '@jander99/ai-review-review-pipeline';
import { getEventContext, titleOrRefForHeading } from './event-context';
import { parsePrompts } from './prompt-composer';
import type { EventContext } from './types';

export { DEFAULT_THRESHOLDS };
export { titleOrRefForHeading };

/** Excludes for the diff the reviewer (and the pipeline) sees: generated bundles are not reviewable. */
export const REVIEW_DIFF_EXCLUDE_PATHSPECS: ReadonlyArray<string> = [
  ':(exclude)dist/**',
  ':(exclude)packages/*/dist*/**',
];

export const REVIEW_DIFF_MAX_BYTES = 200_000;

/** Instruction files read from the base commit, most specific first. */
export const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'] as const;
export const REPO_INSTRUCTION_MAX_CHARS = 32_000;
/** Per-file cap for head file text handed to the proposer. */
export const CONTEXT_FILE_MAX_BYTES = 1_000_000;

/**
 * The filtered diff for this event, or `''` when none is available. An empty
 * diff is a real state (nothing to review), so no placeholder is invented.
 */
export function computeReviewDiff(ctx: EventContext, workingDir: string): { diff: string; truncated: boolean } {
  const range = resolveDiffRange(ctx, workingDir);
  if (!range) {
    return { diff: '', truncated: false };
  }
  const result = spawnSync('git', ['-C', workingDir, 'diff', range, '--', ...REVIEW_DIFF_EXCLUDE_PATHSPECS], {
    encoding: 'utf8',
    maxBuffer: REVIEW_DIFF_MAX_BYTES * 2,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    return { diff: '', truncated: false };
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (!stdout.trim()) {
    return { diff: '', truncated: false };
  }
  if (stdout.length <= REVIEW_DIFF_MAX_BYTES) {
    return { diff: stdout, truncated: false };
  }
  return { diff: stdout.slice(0, REVIEW_DIFF_MAX_BYTES), truncated: true };
}

function resolveDiffRange(ctx: EventContext, workingDir: string): string | null {
  if (ctx.eventName === 'pull_request') {
    return ctx.baseSha && ctx.headSha ? `${ctx.baseSha}..${ctx.headSha}` : null;
  }
  if (ctx.eventName === 'push') {
    return ctx.before && ctx.after ? `${ctx.before}..${ctx.after}` : null;
  }
  const probe = spawnSync('git', ['-C', workingDir, 'rev-parse', '--verify', '--quiet', 'HEAD~1'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
  return probe.status === 0 ? 'HEAD~1..HEAD' : null;
}

/**
 * Instruction files as of the base commit. Reading them from the head would
 * let a PR rewrite the rules it is reviewed under.
 */
export function readBaseInstructions(workingDir: string, baseSha: string | undefined): ContextFile[] {
  if (!baseSha) {
    return [];
  }
  const files: ContextFile[] = [];
  for (const file of REPO_INSTRUCTION_FILES) {
    const result = spawnSync('git', ['-C', workingDir, 'show', `${baseSha}:${file}`], {
      encoding: 'utf8',
      maxBuffer: REPO_INSTRUCTION_MAX_CHARS * 8,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) {
      continue;
    }
    files.push({ path: file, text: result.stdout.slice(0, REPO_INSTRUCTION_MAX_CHARS) });
  }
  return files;
}

function readHeadFiles(workingDir: string, diff: string): ContextFile[] {
  const files: ContextFile[] = [];
  for (const file of parseUnifiedDiff(diff)) {
    if (file.status === 'deleted' || REPO_INSTRUCTION_FILES.includes(file.path as (typeof REPO_INSTRUCTION_FILES)[number])) {
      // Instruction files are supplied from the base commit, never the head:
      // a PR must not be able to rewrite the rules it is reviewed under.
      continue;
    }
    const target = path.join(workingDir, file.path);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > CONTEXT_FILE_MAX_BYTES) {
        continue;
      }
      const text = fs.readFileSync(target, 'utf8');
      if (text.includes('\u0000')) {
        continue;
      }
      files.push({ path: file.path, text });
    } catch {
      // File is in the diff but not on disk (e.g. a partial checkout): skip it.
    }
  }
  return files;
}

export interface RunReviewsOptions {
  prompts: string;
  llm: { provider: string; config: ProviderConfig };
  decision: { provider: string; config: ProviderConfig };
  thresholds: PolicyThresholds;
  githubToken?: string;
  /** Tests only: swap the real client factories. */
  clientFactories?: { llm: typeof createLlmClient; decision: typeof createDecisionClient };
}

export interface RunReviewsResult {
  status: PipelineStatus;
  review: string;
  reviewOutputPath: string;
  triage: string;
  kept: ReadonlyArray<PostableFinding>;
  uncertain: ReadonlyArray<PostableFinding>;
  counts: ReviewPipelineResult['counts'];
  usage: ReviewPipelineResult['usage'];
  diff: string;
  headSha: string;
  failureReason: string;
}

export async function runReviews(options: RunReviewsOptions): Promise<RunReviewsResult> {
  const empty: RunReviewsResult = {
    status: 'failed',
    review: '',
    reviewOutputPath: '',
    triage: '',
    kept: [],
    uncertain: [],
    counts: { kept: 0, uncertain: 0, dropped: 0, duplicates: 0, unjudged: 0 },
    usage: { llmInputTokens: 0, llmOutputTokens: 0, decisionInputTokens: 0 },
    diff: '',
    headSha: '',
    failureReason: '',
  };

  try {
    validateThresholds(options.thresholds);
  } catch (err) {
    return { ...empty, failureReason: err instanceof Error ? err.message : String(err) };
  }

  let llm: LlmClient;
  let decisions: DecisionClient;
  try {
    const factories = options.clientFactories ?? { llm: createLlmClient, decision: createDecisionClient };
    llm = factories.llm(options.llm.provider, options.llm.config);
    decisions = factories.decision(options.decision.provider, options.decision.config);
  } catch (err) {
    return { ...empty, failureReason: `Review setup failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const ctx = getEventContext();
  const workingDir = process.env.GITHUB_WORKSPACE || process.cwd();
  const { diff, truncated } = computeReviewDiff(ctx, workingDir);
  const headSha = ctx.headSha ?? ctx.after ?? '';
  const reviewOutputPath = ctx.reviewOutputPath ?? '';

  let priorFindings: PriorFinding[] = [];
  if (ctx.eventName === 'pull_request' && ctx.prNumber && ctx.repository) {
    const [owner, ...rest] = ctx.repository.split('/');
    try {
      const prior = await fetchPriorReviews({
        token: options.githubToken,
        owner,
        repo: rest.join('/'),
        issueNumber: ctx.prNumber,
      });
      priorFindings = [...(prior?.findings ?? [])];
    } catch (err) {
      console.warn(`Prior review fetch failed; proceeding without prior findings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const taskPrompt = parsePrompts(options.prompts)
    .map((entry) => entry.content)
    .join('\n\n');

  const result = await runReviewPipeline(
    {
      title: titleOrRefForHeading(ctx),
      prTitle: ctx.prTitle,
      prBody: ctx.prBody,
      diff,
      diffTruncated: truncated,
      files: readHeadFiles(workingDir, diff),
      repoInstructions: readBaseInstructions(workingDir, ctx.baseSha ?? ctx.before),
      taskPrompt,
      priorFindings,
    },
    { llm, decisions, thresholds: options.thresholds, log: (m) => console.log(m) },
  );

  if (reviewOutputPath && result.document) {
    fs.mkdirSync(path.dirname(reviewOutputPath), { recursive: true });
    fs.writeFileSync(reviewOutputPath, result.document, { encoding: 'utf8', mode: 0o600 });
  }

  return {
    status: result.status,
    review: result.document,
    reviewOutputPath,
    triage: result.triage,
    kept: result.kept,
    uncertain: result.uncertain,
    counts: result.counts,
    usage: result.usage,
    diff,
    headSha,
    failureReason: result.failureReason,
  };
}
