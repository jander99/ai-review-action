import * as core from '@actions/core';
import { context } from '@actions/github';
import { Octokit } from '@octokit/rest';

const MAX_SUMMARY_CHARS = 65000;
const TRUNCATION_MARKER = `\n\n---\n*Review truncated at ${MAX_SUMMARY_CHARS} characters.*`;
const TRUNCATION_MARKER_LENGTH = TRUNCATION_MARKER.length;

// Mirror of the GitHub Checks API allowed conclusions. Keep this in sync
// with the description of the `conclusion` input in action.yml.
const CHECK_CONCLUSIONS = [
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'success',
  'skipped',
  'stale',
  'timed_out',
] as const;
type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

(async () => {
  const review = core.getInput('review');
  if (!review) {
    core.warning('review input is empty; skipping check run.');
    core.setOutput('check-run-url', '');
    return;
  }

  const name = core.getInput('name') || 'ai-review';
  let conclusion = core.getInput('conclusion') || 'neutral';
  if (!(CHECK_CONCLUSIONS as readonly string[]).includes(conclusion)) {
    core.warning(`Invalid check-conclusion '${conclusion}'; falling back to 'neutral'.`);
    conclusion = 'neutral';
  }
  const detailsUrl = core.getInput('details-url') || 'https://github.com';

  const headSha = process.env.GITHUB_SHA;
  if (!headSha) {
    core.warning('GITHUB_SHA is not set; cannot create a check run. Skipping.');
    core.setOutput('check-run-url', '');
    return;
  }

  let summary = review;
  if (summary.length > MAX_SUMMARY_CHARS) {
    const effectiveLimit = Math.max(0, MAX_SUMMARY_CHARS - TRUNCATION_MARKER_LENGTH);
    summary = summary.slice(0, effectiveLimit) + TRUNCATION_MARKER;
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
      conclusion: conclusion as CheckConclusion,
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