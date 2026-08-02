import { Octokit } from '@octokit/rest';

export interface PostErrorCommentOptions {
  token: string | undefined;
  reason: string;
  postComment: boolean;
  maxChars: number;
  title: string;
}

export interface PostErrorCommentResult {
  commentUrl: string;
}

export async function postErrorComment(
  options: PostErrorCommentOptions,
  repoContext: { owner: string; repo: string; issueNumber: number },
  octokitFactory: (token: string | undefined) => Octokit = (token) => new Octokit({ auth: token }),
): Promise<PostErrorCommentResult> {
  if (!options.postComment) {
    return { commentUrl: '' };
  }
  if (!options.reason) {
    return { commentUrl: '' };
  }

  const title = options.title || 'AI Review validator rejected the generated review.';
  const effectiveMax = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : 65000;

  const body = [
    `> ⚠️ **${title}**`,
    '',
    `**Reason:** ${options.reason}`,
    '',
    'The PR comment was not published. Check the workflow run for the validator output and the rejected review markdown.',
  ].join('\n');

  let truncated = body;
  if (truncated.length > effectiveMax) {
    const marker = `\n\n---\n*Error comment truncated at ${effectiveMax} characters.*`;
    const limit = Math.max(0, effectiveMax - marker.length);
    truncated = truncated.slice(0, limit) + marker;
  }

  try {
    const octokit = octokitFactory(options.token);
    const response = await octokit.rest.issues.createComment({
      owner: repoContext.owner,
      repo: repoContext.repo,
      issue_number: repoContext.issueNumber,
      body: truncated,
    });
    const commentUrl = response.data.html_url ?? '';
    return { commentUrl };
  } catch {
    return { commentUrl: '' };
  }
}