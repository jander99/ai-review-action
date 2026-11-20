import * as core from '@actions/core';
import { DEFAULT_THRESHOLDS, runReviews, type RunReviewsOptions, type RunReviewsResult } from './main';

function optional(input: string, fallback: number): number {
  const raw = core.getInput(input) || `${fallback}`;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${input} must be a number (received '${raw}')`);
  }
  return value;
}

function buildOptionsFromCore(): RunReviewsOptions {
  return {
    prompts: core.getInput('prompts', { required: true }),
    llm: {
      provider: core.getInput('llm-provider', { required: true }),
      config: {
        apiKey: core.getInput('llm-api-key', { required: true }),
        baseUrl: core.getInput('llm-base-url') || undefined,
        model: core.getInput('llm-model', { required: true }),
      },
    },
    decision: {
      provider: core.getInput('decision-provider', { required: true }),
      config: {
        apiKey: core.getInput('decision-api-key', { required: true }),
        baseUrl: core.getInput('decision-base-url') || undefined,
        model: core.getInput('decision-model', { required: true }),
      },
    },
    thresholds: {
      keep: optional('keep-threshold', DEFAULT_THRESHOLDS.keep),
      drop: optional('drop-threshold', DEFAULT_THRESHOLDS.drop),
      severity: optional('severity-threshold', DEFAULT_THRESHOLDS.severity),
    },
    githubToken: core.getInput('github-token') || process.env.GITHUB_TOKEN,
  };
}

function writeOutputs(result: RunReviewsResult): void {
  core.setOutput('review', result.review);
  core.setOutput('triage', result.triage);
  core.setOutput('review-output-path', result.reviewOutputPath);
  core.setOutput('findings-kept', result.counts.kept);
  core.setOutput('findings-uncertain', result.counts.uncertain);
  core.setOutput('findings-dropped', result.counts.dropped);
  core.setOutput(
    'tokens',
    JSON.stringify({
      llmInput: result.usage.llmInputTokens,
      llmOutput: result.usage.llmOutputTokens,
      decisionInput: result.usage.decisionInputTokens,
    }),
  );
  // `failure-reason` is the single canonical failure output, regardless of
  // which stage produced the failure.
  core.setOutput('failure-reason', result.failureReason);
  if (result.status === 'failed') {
    core.setFailed(result.failureReason || 'Review failed');
  }
}

async function run(): Promise<void> {
  const options = buildOptionsFromCore();
  // Never let keys reach the log, even if they appear in an error message.
  core.setSecret(options.llm.config.apiKey);
  core.setSecret(options.decision.config.apiKey);
  const result = await runReviews(options);
  writeOutputs(result);
}

// Standalone action entrypoint. This file is the leaf action's
// `dist/main.cjs` entrypoint; it MUST stay gated on `require.main ===
// module` so importing the package from the root bundle (which esbuild
// flattens into a single file) does not trigger this IIFE.
if (require.main === module) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    // Emit the canonical failure output before failing the step.
    core.setOutput('failure-reason', `run-reviews failed: ${message}`);
    core.setFailed(`run-reviews failed: ${message}`);
  });
}
