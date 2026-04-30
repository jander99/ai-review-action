import * as core from '@actions/core';
import { context } from '@actions/github';
import { Octokit } from '@octokit/rest';

(async () => {
  const postComment = core.getInput('post-comment');
  if (postComment === 'false') {
    core.setOutput('comment-url', '');
    return;
  }

  const review = core.getInput('review');
  if (!review) {
    core.warning('review input is empty; skipping PR comment.');
    core.setOutput('comment-url', '');
    return;
  }

  const maxChars = parseInt(core.getInput('max-comment-chars') || '65000', 10);
  const effectiveMax = isNaN(maxChars) ? 65000 : maxChars;

  let body = review;
  if (body.length > effectiveMax) {
    body = body.slice(0, effectiveMax) + `\n\n---\n*Review truncated at ${effectiveMax} characters.*`;
  }

  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;

  try {
    const octokit = new Octokit({ auth: token });
    const response = await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
    const commentUrl = response.data.html_url;
    core.setOutput('comment-url', commentUrl);
    core.info(`Posted PR comment: ${commentUrl}`);
  } catch (err) {
    core.warning(`Failed to post PR comment; check token permissions. ${err}`);
    core.setOutput('comment-url', '');
  }
})();
