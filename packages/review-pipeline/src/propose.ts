/**
 * Proposer: one schema-validated LLM call that turns the review context into
 * candidate findings, plus the deterministic filtering that makes them
 * anchorable.
 *
 * Validation is enforced twice — the schema at the provider, and the anchor
 * check here — because a finding the diff cannot show is not worth judging.
 */

import {
  FINDINGS_JSON_SCHEMA,
  PROPOSER_SYSTEM_PROMPT,
  findingId,
  type DiffFile,
  type ProposedFinding,
} from '@jander99/ai-review-review-contract';
import { type LlmClient, type LlmError, type LlmUsage } from '@jander99/ai-review-llm-clients';
import { fence, type ReviewContext } from './context';
import type { ReviewDepth, TriageResult } from './triage';

export const MAX_FINDINGS = 25;
export const LIGHT_MAX_FINDINGS = 5;
export const PROPOSER_MAX_TOKENS = 8192;
export const PROPOSER_SEED = 42;

const DEPTH_INSTRUCTION: Record<ReviewDepth, string> = {
  light: `Report only blocker or major issues; at most ${LIGHT_MAX_FINDINGS} findings.`,
  detailed: `Report every issue you can support with evidence; at most ${MAX_FINDINGS} findings.`,
};

export function buildProposerPrompt(
  ctx: ReviewContext,
  opts: {
    taskPrompt: string;
    repoInstructions: ReadonlyArray<{ path: string; text: string }>;
    triage: TriageResult;
  },
): string {
  const parts: string[] = [opts.taskPrompt, '', DEPTH_INSTRUCTION[opts.triage.depth], `Triage: ${opts.triage.line}`];
  if (ctx.notes.length > 0) {
    parts.push('', 'Context notes:', ...ctx.notes.map((note) => `- ${note}`));
  }
  parts.push('', fence('untrusted_repo_instructions', opts.repoInstructions.map((f) => `## ${f.path}\n${f.text}`).join('\n\n')));
  parts.push('', fence('untrusted_diff', ctx.diff));
  for (const file of ctx.files) {
    parts.push('', fence(`untrusted_file:${file.path}`, file.text));
  }
  return parts.join('\n');
}

export type ProposeOutcome =
  | { status: 'ok'; findings: ProposedFinding[]; usage: LlmUsage }
  | { status: 'invalid'; reason: string; usage: LlmUsage };

function asFindings(value: unknown): ProposedFinding[] {
  const raw = (value as { findings?: unknown })?.findings;
  return Array.isArray(raw) ? (raw as ProposedFinding[]) : [];
}

function isLlmError(err: unknown): err is LlmError {
  // Structural check: the error may cross a bundle boundary, where
  // instanceof against a second copy of the class would be false.
  return err instanceof Error && err.name === 'LlmError' && typeof (err as LlmError).kind === 'string';
}

export async function proposeFindings(
  llm: LlmClient,
  prompt: string,
  diffFiles: ReadonlyArray<DiffFile>,
  depth: ReviewDepth,
  log: (m: string) => void,
): Promise<ProposeOutcome> {
  const usage = { inputTokens: 0, outputTokens: 0 } as { inputTokens: number; outputTokens: number };
  const request = (p: string) => ({
    system: PROPOSER_SYSTEM_PROMPT,
    prompt: p,
    jsonSchema: FINDINGS_JSON_SCHEMA,
    maxTokens: PROPOSER_MAX_TOKENS,
    ...(llm.capabilities.supportsSeed ? { seed: PROPOSER_SEED } : {}),
  });

  const callOnce = async (p: string) => {
    const res = await llm.complete(request(p));
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    return res.value;
  };

  let value: unknown;
  try {
    value = await callOnce(prompt);
  } catch (err) {
    if (!isLlmError(err) || err.kind !== 'invalid_output') {
      throw err;
    }
    try {
      value = await callOnce(
        `${prompt}\n\nYour previous reply failed schema validation: ${err.details ?? err.message}. Reply again with JSON matching the schema.`,
      );
    } catch (retryErr) {
      if (isLlmError(retryErr) && retryErr.kind === 'invalid_output') {
        return { status: 'invalid', reason: retryErr.message, usage };
      }
      throw retryErr;
    }
  }

  const byPath = new Map(diffFiles.filter((f) => f.status !== 'deleted').map((f) => [f.path, f]));
  const kept: ProposedFinding[] = [];
  for (const finding of asFindings(value)) {
    if (!byPath.has(finding.file)) {
      log(`dropped finding: ${finding.file} is not a changed file`);
      continue;
    }
    if (finding.startLine < 1 || finding.endLine < finding.startLine) {
      log(`dropped finding: bad line range ${finding.startLine}-${finding.endLine} in ${finding.file}`);
      continue;
    }
    kept.push({
      ...finding,
      id: findingId(finding.file, finding.title),
      relatedFiles: finding.relatedFiles.filter((p) => byPath.has(p)),
    });
  }

  kept.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine || a.title.localeCompare(b.title));

  const seen = new Set<string>();
  const unique = kept.filter((f) => {
    if (seen.has(f.id)) {
      return false;
    }
    seen.add(f.id);
    return true;
  });

  const limit = depth === 'light' ? LIGHT_MAX_FINDINGS : MAX_FINDINGS;
  if (unique.length > limit) {
    log(`truncated ${unique.length} findings to ${limit}`);
  }

  return { status: 'ok', findings: unique.slice(0, limit), usage };
}
