/**
 * Fetch and sanitize prior review comments posted by the AI review
 * bot for the current pull request.
 *
 * The bot is identified by the canonical GitHub App login
 * `github-actions[bot]`, which is the actor that posts the action's
 * review comments. The module returns at most five most recent
 * comments, truncates each to 4 KB on a non-fence line boundary, caps
 * the total payload at 16 KB, runs every body through the shared
 * `sanitizeModelText` helper so the action cannot accidentally inject
 * orphan tags into the next review prompt, and tracks fenced code
 * blocks during truncation so an open fence never escapes into the
 * result. Returns `null` when no comments are available so callers can
 * degrade to a fresh review.
 */

import type { Octokit } from '@octokit/rest';
import { sanitizeModelText } from '@jander99/ai-review-review-contract';

export const PRIOR_REVIEW_BOT_LOGIN = 'github-actions[bot]';
export const PRIOR_REVIEW_LIMIT = 5;
export const PRIOR_REVIEW_PER_COMMENT_CHARS = 4 * 1024;
export const PRIOR_REVIEW_TOTAL_CHARS = 16 * 1024;
export const PRIOR_REVIEW_PAGE_SIZE = 50;

// Joined between consecutive comment blocks. Length: 9.
const COMMENT_SEPARATOR = '\n\n---\n\n';
// Joined between each comment's header and body.
const HEADER_BODY_SEPARATOR = '\n\n';
// Placeholder appended when truncation would otherwise leave an open
// fenced code block without its closing fence.
const FENCE_CLOSE_PLACEHOLDER = '\n```';

export interface PriorReviewComment {
  readonly id: number;
  readonly author: string | null;
  readonly createdAt: string;
  readonly body: string;
}

export interface PriorReviewsOptions {
  readonly token: string | undefined;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly octokit?: Pick<Octokit, 'rest'>;
  readonly now?: () => Date;
}

export interface PriorReviewsResult {
  readonly comments: ReadonlyArray<PriorReviewComment>;
  readonly combined: string;
}

/**
 * Truncate `text` to at most `maxChars` characters, breaking on a
 * newline so the result never ends mid-line. Track fenced code block
 * state across the truncation: if the boundary slice leaves a fence
 * open, back up to before the most recent opening fence and (when the
 * budget allows) append a closing fence so the model does not see an
 * unterminated ``` block.
 *
 * When `maxChars` is larger than or equal to `text.length`, the input
 * is returned unchanged.
 */
function truncateOnLineBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  // Walk the input line by line, accumulating lines until adding the
  // next line would exceed the budget. Track fence state so we can
  // back up before any opening fence when we have to truncate mid-
  // block.
  const lines = text.split('\n');
  let fenceOpen = false;
  let lastOpeningFenceIndex = -1;
  let lastOpeningFenceLine = '';
  const accepted: string[] = [];
  let usedChars = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineLength = line.length + (accepted.length > 0 ? 1 : 0); // leading '\n'
    if (usedChars + lineLength > maxChars) {
      break;
    }
    usedChars += lineLength;
    accepted.push(line);
    if (line.startsWith('```')) {
      if (fenceOpen) {
        fenceOpen = false;
        lastOpeningFenceIndex = -1;
        lastOpeningFenceLine = '';
      } else {
        fenceOpen = true;
        lastOpeningFenceIndex = accepted.length - 1;
        lastOpeningFenceLine = line;
      }
    }
  }

  if (!fenceOpen) {
    // No orphan fence. The truncation already broke on a line
    // boundary, so joining the accepted lines gives us a clean
    // result. We must still strip any trailing newline so the budget
    // accounting is exact.
    return accepted.join('\n').replace(/\n+$/, '');
  }

  // The truncation landed inside an open fence. Drop everything from
  // the opening fence onward: the kept portion must contain no orphan
  // fences. We deliberately do NOT add a closing fence here because
  // the kept portion has no opening fence either - any closing fence
  // would itself be unpaired. The caller sees a fence-free body and
  // proceeds normally.
  const kept = lastOpeningFenceIndex > 0 ? accepted.slice(0, lastOpeningFenceIndex) : [];
  if (kept.length === 0) {
    // The opening fence was the first line of the body. There is no
    // content to keep; drop the body entirely so the caller sees
    // `bounded === ''` and skips the comment.
    return '';
  }
  const result = kept.join('\n').replace(/\n+$/, '');
  // lastOpeningFenceLine is retained only so callers (and tests) can
  // see which opening fence was the boundary; we do not include it in
  // the output because that would re-open the block.
  void lastOpeningFenceLine;
  return result;
}

function sanitizeBody(raw: string): string {
  return sanitizeModelText(raw).trim();
}

/**
 * Strip a trailing orphan UTF-16 surrogate half (a high surrogate
 * without a matching low surrogate, or a low surrogate without a
 * preceding high surrogate). When the input ends on a complete code
 * unit - including a valid high/low surrogate pair such as a single
 * emoji - it is returned unchanged. This avoids the trap where a
 * naive byte-walk over a JavaScript string would drop a perfectly
 * valid final character (or worse, leave an orphan high surrogate
 * behind after stripping only the low half of a pair).
 *
 * Surrogate pair encoding in JavaScript UTF-16 strings:
 *   - Code points U+0000..U+FFFF: single code unit.
 *   - Code points U+10000..U+10FFFF: high surrogate (0xD800..0xDBFF)
 *     followed by a low surrogate (0xDC00..0xDFFF).
 *   - An unmatched half is invalid UTF-16.
 */
function trimTrailingOrphanSurrogate(text: string): string {
  if (text.length === 0) {
    return text;
  }
  const lastCode = text.charCodeAt(text.length - 1);
  if (lastCode >= 0xdc00 && lastCode <= 0xdfff) {
    // Trailing low surrogate. Check the preceding code unit: if it
    // is a high surrogate, the pair is complete and we keep both.
    if (text.length >= 2) {
      const prevCode = text.charCodeAt(text.length - 2);
      if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
        return text;
      }
    }
    // Otherwise the low surrogate is orphan - strip it.
    return text.slice(0, text.length - 1);
  }
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    // Trailing high surrogate with no following low surrogate - it
    // is always orphan and must be stripped.
    return text.slice(0, text.length - 1);
  }
  // Trailing BMP code unit - complete and safe.
  return text;
}

export function formatPriorReviews(comments: ReadonlyArray<PriorReviewComment>): string {
  const sorted = [...comments].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const trimmed: PriorReviewComment[] = [];
  let total = 0;

  for (const comment of sorted) {
    if (trimmed.length >= PRIOR_REVIEW_LIMIT) {
      break;
    }
    const sanitized = sanitizeBody(comment.body);
    if (!sanitized) {
      continue;
    }
    const truncated = truncateOnLineBoundary(sanitized, PRIOR_REVIEW_PER_COMMENT_CHARS);
    const bounded = trimTrailingOrphanSurrogate(truncated);
    if (!bounded) {
      continue;
    }
    const header = formatHeader(comment);
    const separatorLen = trimmed.length > 0 ? COMMENT_SEPARATOR.length : 0;
    const headerBodySeparatorLen = HEADER_BODY_SEPARATOR.length;
    const itemLen = header.length + headerBodySeparatorLen + bounded.length;
    const projected = separatorLen + itemLen;
    if (total + projected > PRIOR_REVIEW_TOTAL_CHARS) {
      break;
    }
    total += projected;
    trimmed.push({
      id: comment.id,
      author: comment.author,
      createdAt: comment.createdAt,
      body: bounded,
    });
  }

  if (trimmed.length === 0) {
    return '';
  }

  return trimmed
    .map((comment) => `${formatHeader(comment)}${HEADER_BODY_SEPARATOR}${comment.body}`)
    .join(COMMENT_SEPARATOR);
}

function formatHeader(comment: PriorReviewComment): string {
  return `## Comment ${comment.id} (author=${comment.author ?? 'unknown'}, created_at=${comment.createdAt})`;
}

/**
 * Fetch and format prior AI review comments.
 *
 * Returns `null` when:
 *   - the token is missing,
 *   - the issue has no bot-authored comments,
 *   - every bot comment is empty after sanitization,
 *   - the GitHub API request fails.
 */
export async function fetchPriorReviews(
  options: PriorReviewsOptions,
): Promise<PriorReviewsResult | null> {
  if (!options.token) {
    return null;
  }
  const octokit = options.octokit ?? new (await import('@octokit/rest')).Octokit({ auth: options.token });
  try {
    const response = await octokit.rest.issues.listComments({
      owner: options.owner,
      repo: options.repo,
      issue_number: options.issueNumber,
      per_page: PRIOR_REVIEW_PAGE_SIZE,
      sort: 'created',
      direction: 'desc',
    });
    const comments = response.data
      .filter((comment) => comment.user?.login === PRIOR_REVIEW_BOT_LOGIN)
      .map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? null,
        createdAt: comment.created_at,
        body: comment.body ?? '',
      }));
    const combined = formatPriorReviews(comments);
    if (!combined) {
      return null;
    }
    return {
      comments,
      combined,
    };
  } catch {
    return null;
  }
}