/**
 * Finding types shared across the pipeline, plus the stable finding identity
 * used to dedupe and to reference prior findings.
 */

import { createHash } from 'node:crypto';
import type { Severity } from './index';
import type { JudgeSeverity } from './policy';

export interface ProposedFinding {
  readonly id: string;
  readonly file: string;
  readonly relatedFiles: ReadonlyArray<string>;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly claim: string;
  readonly evidence: string;
  readonly suggestedFix: string | null;
}

export interface PriorFinding {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly title: string;
}

export interface PostableFinding {
  readonly finding: ProposedFinding;
  readonly severity: Severity;
  readonly judgeSeverity: JudgeSeverity;
  readonly pSupported: number | null;
  readonly note: string;
}

function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Stable id: `F` + the first 10 hex chars of sha256 over file and normalized title. */
export function findingId(file: string, title: string): string {
  const hash = createHash('sha256').update(`${file}\n${normalizeKey(title)}`).digest('hex');
  return `F${hash.slice(0, 10)}`;
}

const SEVERITY_EMOJI: Readonly<Record<string, string>> = { Critical: '🔴', Warning: '🟡', Suggestion: '🟢' };

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** Fence for a suggestion block: at least three backticks, always longer than any run in `fix`. */
export function suggestionFence(fix: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(fix) + 1));
}

/**
 * One finding as a review comment body: heading, claim, collapsible evidence,
 * an optional suggestion block, and a machine-readable marker last.
 */
export function renderFindingComment(p: PostableFinding, opts: { suggestion: boolean }): string {
  const { finding } = p;
  const emoji = SEVERITY_EMOJI[p.severity] ?? '🟡';
  const parts = [
    `**${emoji} ${p.severity} (${p.judgeSeverity}) — ${finding.title}**`,
    finding.claim,
    `<details><summary>Evidence</summary>`,
    finding.evidence,
    `</details>`,
  ];
  if (opts.suggestion && finding.suggestedFix !== null) {
    const fence = suggestionFence(finding.suggestedFix);
    parts.push(`${fence}suggestion\n${finding.suggestedFix}\n${fence}`);
  }
  parts.push(`<!-- ai-review-finding id=${finding.id} file=${finding.file} line=${finding.startLine} -->`);
  return parts.join('\n\n');
}

const MARKER_RE = /<!--\s*ai-review-finding\s+id=(\S+?)(?:\s+file=(\S+))?(?:\s+line=(\d+))?\s*-->/;
const TITLE_RE = /\*\*.*?\s—\s(.+?)\*\*/;

/**
 * Findings recorded in a review body: each marker, joined with the nearest
 * preceding bold heading for its title. Marker fields win over `fallback`,
 * which supplies the position of an inline review comment.
 */
export function parsePriorFindings(body: string, fallback?: { path: string | null; line: number | null }): PriorFinding[] {
  const out: PriorFinding[] = [];
  const seen = new Set<string>();
  let title: string | null = null;
  for (const text of body.split('\n')) {
    const heading = TITLE_RE.exec(text.trim());
    if (heading) title = heading[1];
    const marker = MARKER_RE.exec(text);
    if (!marker) continue;
    const [, id, file, line] = marker;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      file: file ?? fallback?.path ?? null,
      line: line !== undefined ? Number(line) : fallback?.line ?? null,
      title: title ?? id,
    });
  }
  return out;
}
