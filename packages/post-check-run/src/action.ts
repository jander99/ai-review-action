import * as core from '@actions/core';
import { context } from '@actions/github';
import { postCheckRun, type PostCheckRunOptions, type PostCheckRunResult } from './main';

function buildOptionsFromCore(): PostCheckRunOptions {
  return {
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    review: core.getInput('review'),
    name: core.getInput('name'),
    conclusion: core.getInput('conclusion'),
    detailsUrl: core.getInput('details-url'),
    headSha: process.env.GITHUB_SHA ?? '',
    owner: context.repo.owner,
    repo: context.repo.repo,
  };
}

function writeOutputs(result: PostCheckRunResult): void {
  core.setOutput('check-run-url', result.checkRunUrl);
}

async function run(): Promise<void> {
  const options = buildOptionsFromCore();
  const result = await postCheckRun(options);
  writeOutputs(result);
}

if (require.main === module) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`post-check-run failed: ${message}`);
  });
}