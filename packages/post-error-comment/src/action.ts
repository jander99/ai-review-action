import * as core from '@actions/core';
import { context } from '@actions/github';
import { postErrorComment, type PostErrorCommentOptions, type PostErrorCommentResult } from './main';

function buildOptionsFromCore(): PostErrorCommentOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    reason: core.getInput('reason'),
    postComment: core.getInput('post-comment') !== 'false',
    maxChars: Number.parseInt(core.getInput('max-comment-chars') || '65000', 10),
    title: core.getInput('title'),
  };
}

function writeOutputs(result: PostErrorCommentResult): void {
  core.setOutput('comment-url', result.commentUrl);
}

async function run(): Promise<void> {
  const options = buildOptionsFromCore();
  const result = await postErrorComment(options, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issueNumber: context.issue.number,
  });
  writeOutputs(result);
}

if (require.main === module) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`post-error-comment failed: ${message}`);
  });
}