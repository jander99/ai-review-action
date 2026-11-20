/**
 * Judge every proposed finding, concurrently but bounded.
 *
 * Each finding gets the hunks it touches, a numbered slice of context
 * around it, and the prior findings — trimmed until the request fits the
 * client's input limit, or skipped when it cannot fit at all.
 */

import type { DiffFile, FindingJudgement, PriorFinding, ProposedFinding } from '@jander99/ai-review-review-contract';
import type { DecisionClient } from '@jander99/ai-review-decisions';
import { buildJudgeRequest, judgeFinding } from './judge';
import { estimateTokens } from './context';
import { runPool } from './pool';

export const JUDGE_CONCURRENCY = 3;
export const CONTEXT_SLICE_RADIUS = 40;

export interface JudgedFinding {
  readonly finding: ProposedFinding;
  /** null = unjudged: too large for the model's input limit. */
  readonly judgement: FindingJudgement | null;
}

function numberedSlice(text: string, startLine: number, endLine: number): string {
  const lines = text.split('\n');
  const from = Math.max(1, startLine - CONTEXT_SLICE_RADIUS);
  const to = Math.min(lines.length, endLine + CONTEXT_SLICE_RADIUS);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    out.push(`${n}: ${lines[n - 1] ?? ''}`);
  }
  return out.join('\n');
}

export async function judgeAll(
  client: DecisionClient,
  findings: ReadonlyArray<ProposedFinding>,
  ctx: {
    diffFiles: ReadonlyArray<DiffFile>;
    fileTexts: ReadonlyMap<string, string>;
    priorFindings: ReadonlyArray<PriorFinding>;
  },
): Promise<{ judged: JudgedFinding[]; failures: unknown[]; inputTokens: number }> {
  const texts = new Map(ctx.diffFiles.map((f) => [f.path, f.text]));
  const priorFindings = ctx.priorFindings.slice(-50);
  const maxInputTokens = client.capabilities.maxInputTokens;

  const judged: JudgedFinding[] = [];
  let inputTokens = 0;

  const settled = await runPool(findings, JUDGE_CONCURRENCY, async (finding) => {
    const hunkPaths = [finding.file, ...finding.relatedFiles];
    const hunks = hunkPaths
      .map((path) => texts.get(path) ?? '')
      .filter((text) => text !== '')
      .join('\n\n');
    const fileText = ctx.fileTexts.get(finding.file) ?? texts.get(finding.file) ?? '';
    const context = numberedSlice(fileText, finding.startLine, finding.endLine);

    let input = { finding, hunks, context, priorFindings };
    if (estimateTokens(buildJudgeRequest(input).state) > maxInputTokens) {
      input = { ...input, context: '' };
    }
    if (estimateTokens(buildJudgeRequest(input).state) > maxInputTokens) {
      return { finding, judgement: null };
    }
    const { judgement, inputTokens: used } = await judgeFinding(client, input);
    inputTokens += used;
    return { finding, judgement };
  });

  const failures: unknown[] = [];
  for (const outcome of settled) {
    if (outcome.ok) {
      judged.push(outcome.value);
    } else {
      failures.push(outcome.error);
    }
  }

  return { judged, failures, inputTokens };
}
