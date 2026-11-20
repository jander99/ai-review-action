/**
 * Post findings as one batched pull-request review.
 *
 * Inline comments are only possible on lines the diff shows, so findings are
 * planned against the parsed diff first: anchored ones become inline
 * comments, the rest are folded into the review body. A review GitHub
 * rejects (422) is retried once as body-only rather than lost.
 */

import { Octokit } from '@octokit/rest';
import {
  findAnchorHunk,
  parseUnifiedDiff,
  renderFindingComment,
  type PostableFinding,
} from '@jander99/ai-review-review-contract';

export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

export interface InlineComment {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

const INLINE_BODY_MAX_CHARS = 65_000;
const BODY_ONLY_HEADING = '## Findings not on changed lines';

/** GitHub rejects a review with a 422 when a comment anchors outside the diff. */
const ANCHOR_FAILURE_STATUS = 422;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n*(truncated)*` : text;
}

export function planReviewComments(
  findings: ReadonlyArray<PostableFinding>,
  diff: string,
): { inline: InlineComment[]; bodyOnly: PostableFinding[] } {
  const files = new Map(parseUnifiedDiff(diff).map((f) => [f.path, f]));
  const inline: InlineComment[] = [];
  const bodyOnly: PostableFinding[] = [];

  for (const finding of findings) {
    const file = files.get(finding.finding.file);
    const { startLine, endLine } = finding.finding;
    const hunk = file && file.status !== 'deleted' ? findAnchorHunk(file, startLine, endLine) : null;
    if (!hunk) {
      bodyOnly.push(finding);
      continue;
    }
    const body = truncate(renderFindingComment(finding, { suggestion: true }), INLINE_BODY_MAX_CHARS);
    inline.push(
      startLine === endLine
        ? { path: finding.finding.file, line: endLine, side: 'RIGHT', body }
        : { path: finding.finding.file, start_line: startLine, start_side: 'RIGHT', line: endLine, side: 'RIGHT', body },
    );
  }

  return { inline, bodyOnly };
}

export interface PostReviewOptions {
  token: string | undefined;
  postComment: boolean;
  body: string;
  findings: ReadonlyArray<PostableFinding>;
  diff: string;
  commitSha: string;
  event: ReviewEvent;
  maxChars: number;
}

export interface PostReviewResult {
  reviewUrl: string;
  inlineCount: number;
  bodyOnlyCount: number;
}

function truncateBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) {
    return body;
  }
  const truncationMarker = `\n\n---\n*Review truncated at ${maxChars} characters.*`;
  const effectiveLimit = Math.max(0, maxChars - truncationMarker.length);
  return body.slice(0, effectiveLimit) + truncationMarker;
}

function withBodyOnlySection(body: string, bodyOnly: ReadonlyArray<PostableFinding>): string {
  if (bodyOnly.length === 0) {
    return body;
  }
  const rendered = bodyOnly.map((f) => renderFindingComment(f, { suggestion: false })).join('\n\n---\n\n');
  return `${body}\n\n${BODY_ONLY_HEADING}\n\n${rendered}`;
}

export async function postReview(
  options: PostReviewOptions,
  ctx: { owner: string; repo: string; pullNumber: number },
  octokitFactory: (token: string | undefined) => Octokit = (token) => new Octokit({ auth: token }),
): Promise<PostReviewResult> {
  const { inline, bodyOnly } = planReviewComments(options.findings, options.diff);
  if (!options.postComment) {
    return { reviewUrl: '', inlineCount: inline.length, bodyOnlyCount: bodyOnly.length };
  }

  const octokit = octokitFactory(options.token);
  const base = {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.pullNumber,
    commit_id: options.commitSha,
    event: options.event,
  };
  const body = truncateBody(withBodyOnlySection(options.body, bodyOnly), options.maxChars);

  try {
    const response = await octokit.rest.pulls.createReview({ ...base, body, comments: inline });
    return { reviewUrl: response.data.html_url ?? '', inlineCount: inline.length, bodyOnlyCount: bodyOnly.length };
  } catch (err) {
    if ((err as { status?: number }).status !== ANCHOR_FAILURE_STATUS) {
      throw err;
    }
    // The inline anchors were rejected: keep the content by posting every
    // finding in the body instead of losing the review.
    const fallback = truncateBody(withBodyOnlySection(options.body, options.findings), options.maxChars);
    const retry = await octokit.rest.pulls.createReview({ ...base, body: fallback, comments: [] });
    return { reviewUrl: retry.data.html_url ?? '', inlineCount: 0, bodyOnlyCount: options.findings.length };
  }
}
