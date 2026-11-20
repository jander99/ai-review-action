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

function location(finding: PostableFinding): string {
  const { file, startLine, endLine } = finding.finding;
  return startLine === endLine ? `${file}:${startLine}` : `${file}:${startLine}-${endLine}`;
}

function description(finding: PostableFinding): string {
  const { claim } = finding.finding;
  return finding.note ? `${claim} (${finding.note})` : claim;
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
    title: finding.finding.title,
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
