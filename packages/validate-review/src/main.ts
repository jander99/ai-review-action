import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VALIDATOR_AGENT_PROMPT_TEMPLATE } from '@jander99/ai-review-review-contract';
import { validateReviewDocument } from './structure';

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
const VALIDATOR_PERMISSION = {
  read: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  webfetch: 'deny',
  edit: 'deny',
  question: 'deny',
  doom_loop: 'deny',
  bash: 'deny',
} as const;
const FAILURE_REASON_MAX_CHARS = 1024;
const FAILURE_REASON_ELLIPSIS = '...';

function capReason(message: string): string {
  if (message.length <= FAILURE_REASON_MAX_CHARS) {
    return message;
  }
  const keep = FAILURE_REASON_MAX_CHARS - FAILURE_REASON_ELLIPSIS.length;
  return `${message.slice(0, keep)}${FAILURE_REASON_ELLIPSIS}`;
}

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

interface InvokeValidatorOptions {
  reviewPath: string;
  reviewContent: string;
  model: string;
  timeoutMinutes: number;
  passedConfigJson: string;
}

interface InvokeValidatorResult {
  text: string;
  tokens: { input: number; output: number };
  cost: number;
}

function invokeValidator(options: InvokeValidatorOptions): InvokeValidatorResult {
  const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
  const homeDir = fs.mkdtempSync(path.join(runnerTemp, 'ai-review-validate-'));
  fs.chmodSync(homeDir, 0o700);

  const prompt = VALIDATOR_AGENT_PROMPT_TEMPLATE
    .replace('__REVIEW_PATH__', options.reviewPath)
    .concat('\n\n---\n\nReview file contents:\n\n', options.reviewContent);

  let baseConfig: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(options.passedConfigJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      baseConfig = parsed as Record<string, unknown>;
    } else {
      throw new Error('passed config is not a JSON object');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse passed OpenCode config: ${message}`);
  }

  if (baseConfig.__validator__ !== true) {
    throw new Error(
      'passed config is not a validator-only config (missing __validator__: true marker)',
    );
  }

  const provider =
    baseConfig.provider && typeof baseConfig.provider === 'object' && !Array.isArray(baseConfig.provider)
      ? (baseConfig.provider as Record<string, unknown>)
      : {};

  const mergedConfig = {
    provider,
    agent: {
      validator: {
        description: 'Validates the structural shape of a review markdown file.',
        mode: 'primary' as const,
        prompt,
      },
    },
    default_agent: 'validator',
    model: options.model,
    permission: VALIDATOR_PERMISSION,
  };

  const configPath = path.join(homeDir, 'opencode.json');
  fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2), 'utf8');

  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('OPENCODE_')) {
      delete env[name];
    }
  }
  env.OPENCODE_CONFIG = configPath;
  env.HOME = homeDir;

  const result = spawnSync(
    'opencode',
    ['run', prompt, '--model', options.model, '--format', 'json'],
    {
      env,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: options.timeoutMinutes * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

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

/**
 * Options consumed by the programmatic validator. Callers MUST supply
 * every input as a field on this object; the function does not
 * touch `core` directly.
 */
export interface ValidateReviewOptions {
  opencodeVersion: string;
  reviewPath: string;
  model: string;
  timeoutMinutes: number;
  passedConfigJson: string;
}

/**
 * Result of the programmatic validator. Mirrors the action outputs
 * so the standalone action wrapper can write them via
 * `core.setOutput` and the root action can use them as plain fields.
 */
export interface ValidateReviewResult {
  status: 'valid' | 'invalid';
  reason: string;
  cost: number;
  tokens: { input: number; output: number };
  failureReason: string;
}

const EMPTY_RESULT: ValidateReviewResult = {
  status: 'invalid',
  reason: '',
  cost: 0,
  tokens: { input: 0, output: 0 },
  failureReason: '',
};

export async function validateReview(options: ValidateReviewOptions): Promise<ValidateReviewResult> {
  try {
    assertOpenCodeVersion(options.opencodeVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...EMPTY_RESULT,
      reason: capReason(`OpenCode version assertion failed: ${message}`),
      failureReason: `OpenCode version assertion failed: ${message}`,
    };
  }

  if (!options.reviewPath) {
    const reason = 'review-path input is required';
    return {
      ...EMPTY_RESULT,
      reason: capReason(reason),
      failureReason: reason,
    };
  }

  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    const reason = 'timeout-minutes must be a positive integer';
    return {
      ...EMPTY_RESULT,
      reason: capReason(reason),
      failureReason: reason,
    };
  }

  if (!options.passedConfigJson) {
    const reason = 'config-json input is required (resolved validator-only OpenCode config from run-reviews)';
    return {
      ...EMPTY_RESULT,
      reason: capReason(reason),
      failureReason: reason,
    };
  }

  let reviewContent: string;
  try {
    reviewContent = readReviewFile(options.reviewPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...EMPTY_RESULT,
      reason: capReason(message),
      failureReason: `Cannot read review file: ${message}`,
    };
  }

  const structural = validateReviewDocument(reviewContent);
  if (!structural.valid) {
    return {
      ...EMPTY_RESULT,
      reason: capReason(structural.reason),
      failureReason: `Review failed structural validation: ${structural.reason}`,
    };
  }

  let result: InvokeValidatorResult;
  try {
    result = invokeValidator({
      reviewPath: options.reviewPath,
      reviewContent,
      model: options.model,
      timeoutMinutes: options.timeoutMinutes,
      passedConfigJson: options.passedConfigJson,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...EMPTY_RESULT,
      reason: capReason(`validator invocation failed: ${message}`),
      failureReason: `Validator invocation failed: ${message}`,
    };
  }

  const verdict = parseValidatorResponse(result.text);
  return {
    status: verdict.status,
    reason: capReason(verdict.reason),
    cost: result.cost,
    tokens: result.tokens,
    failureReason: verdict.status === 'invalid' ? `Review validation failed: ${verdict.reason}` : '',
  };
}