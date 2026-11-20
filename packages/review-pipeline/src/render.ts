/**
 * Rendering: pipeline findings → the canonical review document.
 *
 * The document is the product, so it goes through the same contract every
 * other review does — this only chooses the content, never the shape.
 */

import {
  renderDocument,
  type DiffFile,
  type ParsedDocument,
  type PostableFinding,
} from '@jander99/ai-review-review-contract';
import type { ReviewDepth } from './triage';

const SEVERITY_RANK: Readonly<Record<string, number>> = { Critical: 0, Warning: 1, Suggestion: 2 };

export interface RenderReviewArgs {
  readonly title: string;
  readonly triage: string;
  readonly scope: string[];
  readonly kept: PostableFinding[];
  readonly uncertain: PostableFinding[];
  readonly duplicates: number;
  readonly depth: ReviewDepth;
  readonly diffFiles: ReadonlyArray<DiffFile>;
  readonly changedLines: number;
}

const MAX_FIELD_CHARS = 400;

/** One line, no markdown block syntax at the start, bounded length. */
function oneLine(text: string, max = MAX_FIELD_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function location(finding: PostableFinding): string {
  const { file, startLine, endLine } = finding.finding;
  const path = file.replace(/[\s,]+/g, '_');
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

function description(finding: PostableFinding): string {
  const { claim } = finding.finding;
  return oneLine(finding.note ? `${claim} (${finding.note})` : claim);
}

export function renderReview(args: RenderReviewArgs): string {
  const sortFindings = (list: PostableFinding[]) =>
    [...list].sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        a.finding.file.localeCompare(b.finding.file) ||
        a.finding.startLine - b.finding.startLine,
    );

  const toParsed = (finding: PostableFinding) => ({
    severity: finding.severity,
    emoji: finding.severity === 'Critical' ? '🔴' : finding.severity === 'Warning' ? '🟡' : '🟢',
    title: oneLine(finding.finding.title, 150),
    status: 'new' as const,
    location: location(finding),
    description: description(finding),
  });

  const document: ParsedDocument = {
    title: args.title,
    triage: args.triage,
    scope: [
      `Reviewed ${args.diffFiles.length} files (${args.changedLines} changed lines); depth: ${args.depth}.`,
      ...args.scope,
    ],
    summary: {
      new: args.kept.length,
      unresolved: args.duplicates,
      resolved: 0,
      ...(args.uncertain.length > 0 ? { uncertain: args.uncertain.length } : {}),
    },
    findings: sortFindings(args.kept).map(toParsed),
    ...(args.uncertain.length > 0 ? { uncertain: sortFindings(args.uncertain).map(toParsed) } : {}),
  };

  return renderDocument(document);
}
