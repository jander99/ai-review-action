import * as core from '@actions/core';
import { context } from '@actions/github';
import { Octokit } from '@octokit/rest';

const MAX_SUMMARY_CHARS = 65000;

(async () => {
  const review = core.getInput('review');
  if (!review) {
    core.warning('review input is empty; skipping check run.');
    core.setOutput('check-run-url', '');
    return;
  }

  const name = core.getInput('name') || 'ai-review';
  const conclusion = core.getInput('conclusion') || 'neutral';
  const detailsUrl = core.getInput('details-url') || 'https://github.com';

  const headSha = process.env.GITHUB_SHA;
  if (!headSha) {
    core.warning('GITHUB_SHA is not set; cannot create a check run. Skipping.');
    core.setOutput('check-run-url', '');
    return;
  }

  let summary = review;
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary =
      summary.slice(0, MAX_SUMMARY_CHARS) +
      `\n\n---\n*Review truncated at ${MAX_SUMMARY_CHARS} characters.*`;
  }

  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
  const { owner, repo } = context.repo;

  try {
    const octokit = new Octokit({ auth: token });
    const response = await octokit.rest.checks.create({
      owner,
      repo,
      name,
      head_sha: headSha,
      status: 'completed',
      // The conclusion input is user-controlled but constrained to the
      // GitHub Checks API allowed values via the action.yml description.
      conclusion: conclusion as
        | 'action_required'
        | 'cancelled'
        | 'failure'
        | 'neutral'
        | 'success'
        | 'skipped'
        | 'stale'
        | 'timed_out',
      details_url: detailsUrl,
      output: {
        title: name,
        summary,
      },
    });
    const checkRunUrl = response.data.html_url;
    core.setOutput('check-run-url', checkRunUrl);
    core.info(`Created check run: ${checkRunUrl}`);
  } catch (err) {
    core.warning(`Failed to create check run; check token permissions. ${err}`);
    core.setOutput('check-run-url', '');
  }
})();