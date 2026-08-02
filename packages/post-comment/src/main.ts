import { Octokit } from '@octokit/rest';

export interface PostCommentOptions {
  token: string | undefined;
  review: string;
  postComment: boolean;
  maxChars: number;
}

export interface PostCommentResult {
  commentUrl: string;
}

export async function postComment(
  options: PostCommentOptions,
  repoContext: { owner: string; repo: string; issueNumber: number },
  octokitFactory: (token: string | undefined) => Octokit = (token) => new Octokit({ auth: token }),
): Promise<PostCommentResult> {
  if (!options.postComment) {
    return { commentUrl: '' };
  }
  if (!options.review) {
    return { commentUrl: '' };
  }

  const effectiveMax = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : 65000;

  let body = options.review;
  if (body.length > effectiveMax) {
    const truncationMarker = `\n\n---\n*Review truncated at ${effectiveMax} characters.*`;
    const effectiveLimit = Math.max(0, effectiveMax - truncationMarker.length);
    body = body.slice(0, effectiveLimit) + truncationMarker;
  }

  try {
    const octokit = octokitFactory(options.token);
    const response = await octokit.rest.issues.createComment({
      owner: repoContext.owner,
      repo: repoContext.repo,
      issue_number: repoContext.issueNumber,
      body,
    });
    const commentUrl = response.data.html_url ?? '';
    return { commentUrl };
  } catch {
    return { commentUrl: '' };
  }
}