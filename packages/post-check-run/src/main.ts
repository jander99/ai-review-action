import { Octokit } from '@octokit/rest';

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

const MAX_SUMMARY_CHARS = 65000;
const TRUNCATION_MARKER = `\n\n---\n*Review truncated at ${MAX_SUMMARY_CHARS} characters.*`;
const TRUNCATION_MARKER_LENGTH = TRUNCATION_MARKER.length;

export interface PostCheckRunOptions {
  token: string | undefined;
  review: string;
  name: string;
  conclusion: string;
  detailsUrl: string;
  headSha: string;
  owner: string;
  repo: string;
}

export interface PostCheckRunResult {
  checkRunUrl: string;
}

export async function postCheckRun(
  options: PostCheckRunOptions,
  octokitFactory: (token: string | undefined) => Octokit = (token) => new Octokit({ auth: token }),
): Promise<PostCheckRunResult> {
  if (!options.review) {
    return { checkRunUrl: '' };
  }

  const name = options.name || 'ai-review';
  let conclusion: string = options.conclusion || 'neutral';
  if (!(CHECK_CONCLUSIONS as readonly string[]).includes(conclusion)) {
    conclusion = 'neutral';
  }
  const detailsUrl = options.detailsUrl || 'https://github.com';

  if (!options.headSha) {
    return { checkRunUrl: '' };
  }

  let summary = options.review;
  if (summary.length > MAX_SUMMARY_CHARS) {
    const effectiveLimit = Math.max(0, MAX_SUMMARY_CHARS - TRUNCATION_MARKER_LENGTH);
    summary = summary.slice(0, effectiveLimit) + TRUNCATION_MARKER;
  }

  try {
    const octokit = octokitFactory(options.token);
    const response = await octokit.rest.checks.create({
      owner: options.owner,
      repo: options.repo,
      name,
      head_sha: options.headSha,
      status: 'completed',
      conclusion: conclusion as CheckConclusion,
      details_url: detailsUrl,
      output: {
        title: name,
        summary,
      },
    });
    const checkRunUrl = response.data.html_url ?? '';
    return { checkRunUrl };
  } catch {
    return { checkRunUrl: '' };
  }
}