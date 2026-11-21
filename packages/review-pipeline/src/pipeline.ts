/**
 * The review pipeline: triage → propose → judge → policy → render.
 *
 * Pure orchestration over injected clients — no @actions/core, no env reads,
 * no process.exit — so the same code runs in the action, in tests, and in the
 * stability study. Every failure returns a reason instead of throwing,
 * because a half-finished review must never be posted.
 */

import {
  MAX_CHARS,
  applyPolicy,
  countChangedLines,
  JUDGE_TO_CONTRACT_SEVERITY,
  parseUnifiedDiff,
  validateReviewDocument,
  type PolicyThresholds,
  type PostableFinding,
  type PriorFinding,
} from '@jander99/ai-review-review-contract';
import type { DecisionClient } from '@jander99/ai-review-decisions';
import type { LlmClient } from '@jander99/ai-review-llm-clients';
import { buildReviewContext, type ContextFile } from './context';
import { judgeAll } from './judge-all';
import { buildProposerPrompt, proposeFindings } from './propose';
import { renderReview } from './render';
import { buildTriageRequest, decideTriage } from './triage';

export interface PipelineInput {
  readonly title: string;
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly files: ReadonlyArray<ContextFile>;
  readonly repoInstructions: ReadonlyArray<ContextFile>;
  readonly taskPrompt: string;
  readonly priorFindings: ReadonlyArray<PriorFinding>;
}

export interface ReviewPipelineDeps {
  readonly llm: LlmClient;
  readonly decisions: DecisionClient;
  readonly thresholds: PolicyThresholds;
  readonly log: (m: string) => void;
}

export type PipelineStatus = 'ok' | 'no_findings_produced' | 'failed';

export interface ReviewPipelineResult {
  readonly status: PipelineStatus;
  readonly document: string;
  readonly triage: string;
  readonly kept: ReadonlyArray<PostableFinding>;
  readonly uncertain: ReadonlyArray<PostableFinding>;
  readonly counts: { kept: number; uncertain: number; dropped: number; duplicates: number; unjudged: number };
  readonly usage: { llmInputTokens: number; llmOutputTokens: number; decisionInputTokens: number };
  readonly failureReason: string;
}

const EMPTY_USAGE = { llmInputTokens: 0, llmOutputTokens: 0, decisionInputTokens: 0 };

function failure(reason: string, triage = '', usage = EMPTY_USAGE): ReviewPipelineResult {
  return {
    status: 'failed',
    document: '',
    triage,
    kept: [],
    uncertain: [],
    counts: { kept: 0, uncertain: 0, dropped: 0, duplicates: 0, unjudged: 0 },
    usage,
    failureReason: reason,
  };
}

function errorKind(err: unknown): string {
  const kind = (err as { kind?: unknown })?.kind;
  return typeof kind === 'string' ? kind : 'other';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runReviewPipeline(input: PipelineInput, deps: ReviewPipelineDeps): Promise<ReviewPipelineResult> {
  const diffFiles = parseUnifiedDiff(input.diff);
  if (diffFiles.length === 0) {
    return {
      status: 'ok',
      document: renderReview({
        title: input.title,
        triage: '',
        scope: ['No reviewable changes (the diff is empty after excluding generated files).'],
        kept: [],
        uncertain: [],
        duplicates: 0,
        depth: 'light',
        diffFiles,
        changedLines: 0,
      }),
      triage: '',
      kept: [],
      uncertain: [],
      counts: { kept: 0, uncertain: 0, dropped: 0, duplicates: 0, unjudged: 0 },
      usage: EMPTY_USAGE,
      failureReason: '',
    };
  }

  const changedLines = countChangedLines(diffFiles);
  const hasIntent = Boolean(input.prTitle || input.prBody);

  let triageRes;
  try {
    triageRes = await deps.decisions.decide(
      buildTriageRequest({ prTitle: input.prTitle, prBody: input.prBody, diff: input.diff }, deps.decisions.capabilities.maxInputTokens),
    );
  } catch (err) {
    return failure(`Decision API failed during triage: ${errorKind(err)}: ${errorMessage(err)}`);
  }
  const triage = decideTriage(triageRes, changedLines, hasIntent, deps.thresholds);
  const decisionInputTokens = triageRes.usage.inputTokens;

  const ctx = buildReviewContext(
    { diff: input.diff, diffTruncated: input.diffTruncated, files: input.files },
    deps.llm.capabilities.maxInputTokens,
  );
  const prompt = buildProposerPrompt(ctx, {
    taskPrompt: input.taskPrompt,
    repoInstructions: input.repoInstructions,
    triage,
  });

  let proposed;
  try {
    proposed = await proposeFindings(deps.llm, prompt, diffFiles, triage.depth, deps.log);
  } catch (err) {
    return failure(`LLM provider failed: ${errorKind(err)}: ${errorMessage(err)}`, triage.line);
  }
  if (proposed.status === 'invalid') {
    return {
      status: 'no_findings_produced',
      document: renderReview({
        title: input.title,
        triage: triage.line,
        scope: ['The proposer returned no valid findings after one retry; this is not a clean pass.'],
        kept: [],
        uncertain: [],
        duplicates: 0,
        depth: triage.depth,
        diffFiles,
        changedLines,
      }),
      triage: triage.line,
      kept: [],
      uncertain: [],
      counts: { kept: 0, uncertain: 0, dropped: 0, duplicates: 0, unjudged: 0 },
      usage: { llmInputTokens: proposed.usage.inputTokens, llmOutputTokens: proposed.usage.outputTokens, decisionInputTokens },
      failureReason: proposed.reason,
    };
  }

  const fileTexts = new Map(input.files.map((file) => [file.path, file.text]));
  const judged = await judgeAll(deps.decisions, proposed.findings, { diffFiles, fileTexts, priorFindings: input.priorFindings });

  const usage = {
    llmInputTokens: proposed.usage.inputTokens,
    llmOutputTokens: proposed.usage.outputTokens,
    decisionInputTokens: decisionInputTokens + judged.inputTokens,
  };

  if (judged.failures.length > 0) {
    return failure(
      `Decision API failed for ${judged.failures.length} of ${proposed.findings.length} findings; not posting a partial review: ${errorMessage(judged.failures[0])}`,
      triage.line,
      usage,
    );
  }

  const kept: PostableFinding[] = [];
  const uncertain: PostableFinding[] = [];
  const counts = { kept: 0, uncertain: 0, dropped: 0, duplicates: 0, unjudged: 0 };

  for (const { finding, judgement } of judged.judged) {
    if (!judgement) {
      counts.unjudged += 1;
      counts.uncertain += 1;
      uncertain.push({
        finding,
        severity: 'Suggestion',
        judgeSeverity: 'nit',
        pSupported: null,
        note: 'unjudged: too large',
      });
      continue;
    }
    const outcome = applyPolicy(judgement, deps.thresholds);
    const severity = JUDGE_TO_CONTRACT_SEVERITY[outcome.severity];
    if (outcome.verdict === 'keep') {
      counts.kept += 1;
      kept.push({ finding, severity, judgeSeverity: outcome.severity, pSupported: judgement.pSupported, note: '' });
    } else if (outcome.verdict === 'uncertain') {
      counts.uncertain += 1;
      uncertain.push({
        finding,
        severity,
        judgeSeverity: outcome.severity,
        pSupported: judgement.pSupported,
        note: `P(supported)=${judgement.pSupported.toFixed(2)}`,
      });
    } else if (outcome.verdict === 'duplicate') {
      counts.duplicates += 1;
    } else {
      counts.dropped += 1;
    }
  }

  const document = renderReview({
    title: input.title,
    triage: triage.line,
    scope: [...ctx.notes],
    kept,
    uncertain,
    duplicates: counts.duplicates,
    depth: triage.depth,
    diffFiles,
    changedLines,
  });

  const validated = validateReviewDocument(document);
  if (!validated.valid) {
    deps.log(`rendered review rejected by validation:\n${document}`);
    return failure(`internal: rendered review failed validation: ${validated.reason}`, triage.line, usage);
  }
  if (document.length > MAX_CHARS) {
    return failure(`internal: rendered review exceeds ${MAX_CHARS} chars`, triage.line, usage);
  }

  return { status: 'ok', document, triage: triage.line, kept, uncertain, counts, usage, failureReason: '' };
}
