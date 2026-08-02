import * as core from '@actions/core';
import { context } from '@actions/github';
import { postComment, type PostCommentOptions, type PostCommentResult } from './main';

function buildOptionsFromCore(): PostCommentOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    review: core.getInput('review'),
    postComment: core.getInput('post-comment') !== 'false',
    maxChars: Number.parseInt(core.getInput('max-comment-chars') || '65000', 10),
  };
}

function writeOutputs(result: PostCommentResult): void {
  core.setOutput('comment-url', result.commentUrl);
}

async function run(): Promise<void> {
  const options = buildOptionsFromCore();
  const result = await postComment(options, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issueNumber: context.issue.number,
  });
  writeOutputs(result);
}

if (require.main === module) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`post-comment failed: ${message}`);
  });
}