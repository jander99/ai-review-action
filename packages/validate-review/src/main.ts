import * as core from '@actions/core';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';

interface OpenCodeEvent {
  type?: string;
  text?: string;
  tokens?: { input?: number; output?: number };
  cost?: number;
  part?: {
    type?: string;
    text?: string;
    tokens?: { input?: number; output?: number };
    cost?: number;
  };
}

const DEFAULT_OPENCODE_VERSION = '1.18.5';
const DEFAULT_TIMEOUT_MINUTES = 5;
const VALIDATION_PROMPT = `You are a structural validator. Read the file at the path supplied below. Do not inspect the repository, do not call tools other than reading that file, and do not propose fixes.

The file must contain, in this order:

1. A heading line that begins with '# Review — <title-or-ref>'.
2. A '## Summary' section containing three bullet items with counts:
   - New findings: <count>
   - Unresolved from prior review: <count>
   - Resolved by latest commits: <count>
3. Optional '## Findings' section. When present, each finding must be a discrete block of the form:

   ### <emoji> <severity> — <short title>
   Status: <new | unresolved | resolved | new variant>
   Location: <path>:<line>
   Description: <text>

   The severity column must be one of: Critical, Warning, Suggestion.
   The 'Status:', 'Location:', and 'Description:' lines are mandatory for every finding.

If the file matches the structure, reply with exactly one line: VALID
If the file is missing or malformed, reply with exactly one line: INVALID <reason>
where <reason> is a short human-readable cause (e.g. "missing ## Summary section", "finding 2 missing Status field"). Do not include any other text in your reply.

Path to validate: <REVIEW_PATH>`;

function assertOpenCodeVersion(expectedVersion: string): void {
  const result = spawnSync('opencode', ['--version'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';

  if (result.error) {
    throw new Error(`could not execute 'opencode --version': ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `'opencode --version' exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`,
    );
  }

  const reportedVersion = stdout || stderr;
  const versionMatch = reportedVersion.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  const installedVersion = (versionMatch?.[1] ?? reportedVersion.replace(/^v/, '')).trim();
  const normalizedExpectedVersion = expectedVersion.replace(/^v/, '');
  if (!installedVersion || installedVersion !== normalizedExpectedVersion) {
    throw new Error(
      `expected OpenCode ${normalizedExpectedVersion}, but 'opencode --version' reported '${reportedVersion || '<empty>'}'`,
    );
  }
}

function readReviewFile(reviewPath: string): string {
  if (!fs.existsSync(reviewPath)) {
    throw new Error(`review file not found at ${reviewPath}`);
  }
  const content = fs.readFileSync(reviewPath, 'utf8');
  if (!content.trim()) {
    throw new Error(`review file at ${reviewPath} is empty`);
  }
  return content;
}

function invokeValidator(
  reviewPath: string,
  reviewContent: string,
  model: string,
  timeoutMinutes: number,
): { text: string; tokens: { input: number; output: number }; cost: number } {
  const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
  const homeDir = fs.mkdtempSync(path.join(runnerTemp, 'ai-review-validate-'));
  fs.chmodSync(homeDir, 0o700);

  const mergedConfig = {
    agent: {
      validator: {
        description: 'Validates the structural shape of a review markdown file.',
        mode: 'primary',
        prompt: VALIDATION_PROMPT.replace('<REVIEW_PATH>', reviewPath),
      },
    },
    default_agent: 'validator',
    model,
    permission: {
      read: 'deny',
      glob: 'deny',
      grep: 'deny',
      list: 'deny',
      webfetch: 'deny',
      edit: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      bash: 'deny',
    },
  };

  const configPath = path.join(homeDir, 'opencode.json');
  fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2), 'utf8');

  // Inline the review content into the prompt so the model does not need
  // the file: read permission. The validator's role is purely structural.
  const prompt = VALIDATION_PROMPT
    .replace('<REVIEW_PATH>', reviewPath)
    .concat('\n\n---\n\nReview file contents:\n\n', reviewContent);

  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('OPENCODE_')) {
      delete env[name];
    }
  }
  env.OPENCODE_CONFIG = configPath;
  env.HOME = homeDir;

  const result = spawnSync('opencode', ['run', prompt, '--model', model, '--format', 'json'], {
    env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: timeoutMinutes * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const errorOutput = (typeof result.stderr === 'string' ? result.stderr : '').trim();
    throw new Error(
      `opencode exited with status ${result.status}${errorOutput ? `: ${errorOutput}` : ''}`,
    );
  }

  const text: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;

  for (const line of (typeof result.stdout === 'string' ? result.stdout : '').split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line) as OpenCodeEvent;
    if (event.type === 'text') {
      const value = event.text ?? event.part?.text;
      if (value) text.push(value);
    } else if (event.part?.type === 'text' && event.part.text) {
      text.push(event.part.text);
    }
    if (event.type === 'step_finish' || event.part?.type === 'step_finish') {
      const tokens = event.tokens ?? event.part?.tokens;
      inputTokens += tokens?.input ?? 0;
      outputTokens += tokens?.output ?? 0;
      cost += event.cost ?? event.part?.cost ?? 0;
    }
  }

  return {
    text: text.join('').trim(),
    tokens: { input: inputTokens, output: outputTokens },
    cost,
  };
}

function parseValidatorResponse(text: string): { status: 'valid' | 'invalid'; reason: string } {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (firstLine === 'VALID') {
    return { status: 'valid', reason: '' };
  }
  if (firstLine.startsWith('INVALID')) {
    const reason = firstLine.slice('INVALID'.length).trim() || 'unspecified';
    return { status: 'invalid', reason };
  }
  return {
    status: 'invalid',
    reason: `validator response did not start with VALID or INVALID: ${firstLine.slice(0, 200)}`,
  };
}

function run(): void {
  const expectedOpenCodeVersion = core.getInput('opencode-version') || DEFAULT_OPENCODE_VERSION;
  try {
    assertOpenCodeVersion(expectedOpenCodeVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setOutput('status', 'invalid');
    core.setOutput('reason', `OpenCode version assertion failed: ${message}`);
    core.setOutput('cost', 0);
    core.setOutput('tokens', JSON.stringify({ input: 0, output: 0 }));
    core.setFailed(`OpenCode version assertion failed: ${message}`);
    return;
  }

  const reviewPath = core.getInput('review-path');
  if (!reviewPath) {
    core.setOutput('status', 'invalid');
    core.setOutput('reason', 'review-path input is required');
    core.setOutput('cost', 0);
    core.setOutput('tokens', JSON.stringify({ input: 0, output: 0 }));
    core.setFailed('review-path input is required');
    return;
  }

  const model = core.getInput('model') || 'anthropic/claude-sonnet-4.6';
  const timeoutMinutes = Number.parseInt(core.getInput('timeout-minutes') || `${DEFAULT_TIMEOUT_MINUTES}`, 10);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    core.setOutput('status', 'invalid');
    core.setOutput('reason', 'timeout-minutes must be a positive integer');
    core.setOutput('cost', 0);
    core.setOutput('tokens', JSON.stringify({ input: 0, output: 0 }));
    core.setFailed('timeout-minutes must be a positive integer');
    return;
  }

  let reviewContent: string;
  try {
    reviewContent = readReviewFile(reviewPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setOutput('status', 'invalid');
    core.setOutput('reason', message);
    core.setOutput('cost', 0);
    core.setOutput('tokens', JSON.stringify({ input: 0, output: 0 }));
    core.setFailed(`Cannot read review file: ${message}`);
    return;
  }

  let result: { text: string; tokens: { input: number; output: number }; cost: number };
  try {
    result = invokeValidator(reviewPath, reviewContent, model, timeoutMinutes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setOutput('status', 'invalid');
    core.setOutput('reason', `validator invocation failed: ${message}`);
    core.setOutput('cost', 0);
    core.setOutput('tokens', JSON.stringify({ input: 0, output: 0 }));
    core.setFailed(`Validator invocation failed: ${message}`);
    return;
  }

  const verdict = parseValidatorResponse(result.text);
  core.setOutput('status', verdict.status);
  core.setOutput('reason', verdict.reason);
  core.setOutput('cost', result.cost);
  core.setOutput('tokens', JSON.stringify(result.tokens));
  if (verdict.status === 'invalid') {
    core.setFailed(`Review validation failed: ${verdict.reason}`);
  }
}

run();
