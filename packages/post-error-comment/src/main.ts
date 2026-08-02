import * as core from '@actions/core';
import { context } from '@actions/github';
import { Octokit } from '@octokit/rest';

(async () => {
  const postComment = core.getInput('post-comment');
  if (postComment === 'false') {
    core.setOutput('comment-url', '');
    return;
  }

  const reason = core.getInput('reason');
  if (!reason) {
    core.warning('reason input is empty; skipping error comment.');
    core.setOutput('comment-url', '');
    return;
  }

  const title = core.getInput('title') || 'AI Review validator rejected the generated review.';
  const maxChars = parseInt(core.getInput('max-comment-chars') || '65000', 10);
  const effectiveMax = isNaN(maxChars) ? 65000 : maxChars;

  const body = [
    `> ⚠️ **${title}**`,
    '',
    `**Reason:** ${reason}`,
    '',
    'The PR comment was not published. Check the workflow run for the validator output and the rejected review markdown.',
  ].join('\n');

  let truncated = body;
  if (truncated.length > effectiveMax) {
    const marker = `\n\n---\n*Error comment truncated at ${effectiveMax} characters.*`;
    const limit = Math.max(0, effectiveMax - marker.length);
    truncated = truncated.slice(0, limit) + marker;
  }

  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;

  try {
    const octokit = new Octokit({ auth: token });
    const response = await octokit.rest.issues.createComment({ owner, repo, issue_number, body: truncated });
    const commentUrl = response.data.html_url;
    core.setOutput('comment-url', commentUrl);
    core.info(`Posted error comment: ${commentUrl}`);
  } catch (err) {
    core.warning(`Failed to post error comment; check token permissions. ${err}`);
    core.setOutput('comment-url', '');
  }
})();
