import * as core from '@actions/core';
import { validateReview, type ValidateReviewOptions, type ValidateReviewResult } from './main';

const DEFAULT_OPENCODE_VERSION = '1.18.4';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_TIMEOUT_MINUTES = 5;

function readStringInput(name: string, fallback: string): string {
  const value = core.getInput(name);
  return value || fallback;
}

function readIntInput(name: string, fallback: number): number {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildOptionsFromCore(): ValidateReviewOptions {
  return {
    opencodeVersion: readStringInput('opencode-version', DEFAULT_OPENCODE_VERSION),
    reviewPath: core.getInput('review-path'),
    model: readStringInput('model', DEFAULT_MODEL),
    timeoutMinutes: readIntInput('timeout-minutes', DEFAULT_TIMEOUT_MINUTES),
    passedConfigJson: core.getInput('config-json'),
  };
}

function writeOutputs(result: ValidateReviewResult): void {
  core.setOutput('status', result.status);
  core.setOutput('reason', result.reason);
  core.setOutput('cost', result.cost);
  core.setOutput('tokens', JSON.stringify(result.tokens));
  if (result.failureReason) {
    core.setFailed(result.failureReason);
  }
}

async function run(): Promise<void> {
  const options = buildOptionsFromCore();
  const result = await validateReview(options);
  writeOutputs(result);
}

if (require.main === module) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`validate-review failed: ${message}`);
  });
}