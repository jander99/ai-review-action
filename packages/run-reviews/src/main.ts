import * as core from '@actions/core';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { buildAgentDefinition, getEventContext } from './agent-definition';
import { buildFusionConfig, buildMergedConfig } from './config-builder';
import { composeFusionPrompt, composeLabeledReviews } from './fusion';
import { invokeOpenCode } from './opencode';
import type { DebugCapturePaths } from './opencode';
import { DEFAULT_PERMISSION } from './permissions';
import { composeTaskPromptWithPreviousReviews, parsePrompts } from './prompt-composer';
import type { Permission, PromptEntry, ReviewResult } from './types';

const DEFAULT_OPENCODE_VERSION = '1.18.5';
// Best-effort only: debug artifacts may still contain sensitive data. AWS secret
// access keys have no tight identifying prefix and cannot be safely pattern-matched.
const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-ant-[A-Za-z0-9._-]+/g, replacement: '[REDACTED]' },
  { pattern: /sk-[A-Za-z0-9._-]+/g, replacement: '[REDACTED]' },
  { pattern: /github_pat_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /ghp_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /ghs_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /gho_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /ghr_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /ghu_[A-Za-z0-9_]+/g, replacement: '[REDACTED]' },
  { pattern: /AIza[A-Za-z0-9_-]{35}/g, replacement: '[REDACTED]' },
  { pattern: /AKIA[A-Z0-9]{16}/g, replacement: '[REDACTED]' },
  { pattern: /Bearer\s+[^\s"'`\\]+/gi, replacement: 'Bearer [REDACTED]' },
];

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

function createDebugDirectory(): string {
  const temporaryRoot = process.env.RUNNER_TEMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const debugDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'ai-review-debug-'));
  fs.chmodSync(debugDirectory, 0o700);
  return debugDirectory;
}

function createDebugCapturePaths(
  directory: string,
  invocation: number,
  kind: 'review' | 'fusion',
  model: string,
): DebugCapturePaths {
  const safeModel = model.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'unknown-model';
  const prefix = `${invocation.toString().padStart(3, '0')}-${kind}-${safeModel}`;
  return {
    stdoutPath: path.join(directory, `${prefix}.stdout.jsonl`),
    stderrPath: path.join(directory, `${prefix}.stderr.log`),
  };
}

function redactDebugOutput(output: string): string {
  return REDACTION_PATTERNS.reduce(
    (redacted, { pattern, replacement }) => redacted.replace(pattern, replacement),
    output,
  );
}

function finalizeDebugDirectory(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith('.gz')) {
      continue;
    }
    const rawPath = path.join(directory, entry.name);
    const redacted = redactDebugOutput(fs.readFileSync(rawPath, 'utf8'));
    fs.writeFileSync(`${rawPath}.gz`, gzipSync(redacted), { mode: 0o600 });
    fs.rmSync(rawPath, { force: true });
  }
}

interface IndividualReviewResult extends ReviewResult {
  prompt: string;
}

function readReviewOutputFile(path: string): string {
  // The model is contractually required to write the review markdown to
  // this path; the action reads the file after the model returns. If the
  // file is missing or empty, the model failed to honor the contract.
  if (!fs.existsSync(path)) {
    throw new Error(`review output file not found at ${path}`);
  }
  const content = fs.readFileSync(path, 'utf8');
  if (!content.trim()) {
    throw new Error(`review output file at ${path} is empty`);
  }
  return content;
}

function readPermission(): Permission {
  const input = core.getInput('permission');
  if (!input) {
    return { ...DEFAULT_PERMISSION };
  }

  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('permission must be a JSON object');
  }
  return parsed as Permission;
}

function setEmptyOutputs(): void {
  core.setOutput('review', '');
  core.setOutput('models-used', '');
  core.setOutput('cost', 0);
  core.setOutput('cost-by-model', '{}');
  core.setOutput('tokens', JSON.stringify({ input: 0, output: 0 }));
  core.setOutput('tokens-by-model', '{}');
}

function compareLexically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function run(): void {
  const expectedOpenCodeVersion = core.getInput('opencode-version') || DEFAULT_OPENCODE_VERSION;
  try {
    assertOpenCodeVersion(expectedOpenCodeVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setEmptyOutputs();
    core.setFailed(`OpenCode version assertion failed: ${message}`);
    return;
  }

  const model = core.getInput('model') || 'anthropic/claude-sonnet-4.6';
  const modelsInput = core.getInput('models');
  const fusionEnabled = core.getBooleanInput('fusion');
  const failOnError = core.getBooleanInput('fail-on-error');
  const debugEnabled = core.getBooleanInput('debug');
  const timeoutMinutes = Number.parseInt(core.getInput('timeout-minutes') || '30', 10);
  const userConfig = core.getInput('opencode-config') || undefined;
  const individualResults: IndividualReviewResult[] = [];
  const accountedResults: ReviewResult[] = [];
  const successfulModels = new Set<string>();
  const failures: string[] = [];
  let prompts: PromptEntry[];
  let effectiveModels: string[];
  let fusionModel: string;
  let configPath: string;
  let homeDir: string;
  let fusionConfigPath = '';
  let fusionHomeDir = '';
  let debugDirectory = '';
  let debugInvocation = 0;

  try {
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
      throw new Error('timeout-minutes must be a positive integer');
    }

    const parsedModels = modelsInput
      ? modelsInput
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [model];
    effectiveModels = [...new Set(parsedModels)];
    if (effectiveModels.length === 0) {
      throw new Error('At least one model is required');
    }

    fusionModel = core.getInput('fusion-model') || effectiveModels[0];
    prompts = parsePrompts(core.getInput('prompts'));
    const agent = buildAgentDefinition(getEventContext());
    ({ configPath, homeDir } = buildMergedConfig({
      userConfig,
      permission: readPermission(),
      agent,
      model: effectiveModels[0],
    }));
    if (fusionEnabled) {
      ({ configPath: fusionConfigPath, homeDir: fusionHomeDir } = buildFusionConfig({
        agent,
        model: fusionModel,
      }));
    }
    if (debugEnabled) {
      debugDirectory = createDebugDirectory();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setEmptyOutputs();
    core.setFailed(`Review setup failed: ${message}`);
    return;
  }

  const orderedPrompts = [...prompts].sort((left, right) => compareLexically(left.source, right.source));
  const orderedModels = [...effectiveModels].sort(compareLexically);

  const eventContext = getEventContext();
  const reviewOutputPath = eventContext.reviewOutputPath;
  if (!reviewOutputPath) {
    setEmptyOutputs();
    core.setFailed('review output path could not be determined for this event');
    return;
  }

  for (const prompt of orderedPrompts) {
    for (const currentModel of orderedModels) {
      core.info(`Running review: ${currentModel} :: ${prompt.source}`);
      try {
        const result = invokeOpenCode(composeTaskPromptWithPreviousReviews([prompt], ''), currentModel, configPath, {
          homeDir,
          timeoutMinutes,
          debugCapture: debugEnabled
            ? createDebugCapturePaths(debugDirectory, ++debugInvocation, 'review', currentModel)
            : undefined,
        });
        individualResults.push({ ...result, prompt: prompt.source });
        accountedResults.push(result);
        successfulModels.add(currentModel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${currentModel} :: ${prompt.source}: ${message}`);
        core.warning(`Review failed for ${currentModel} :: ${prompt.source}: ${message}`);
      }
    }
  }

  // The model is contractually required to write the review markdown to
  // `reviewOutputPath`. Read the file and use it as the review output for
  // multi-model cases where the wrapper is not needed.
  //
  // Fallback: if the file is missing for a single-model run, surface the
  // model response so the validator/poster still has something to inspect.
  // Multi-model runs with no file are treated as a failure.
  let reviewText: string;
  try {
    reviewText = readReviewOutputFile(reviewOutputPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (individualResults.length === 1 && !fusionEnabled) {
      core.warning(`${message}; falling back to the model response text.`);
      reviewText = individualResults[0].text;
    } else {
      setEmptyOutputs();
      core.setFailed(`Review output contract violated: ${message}`);
      core.setOutput('review-output-path', reviewOutputPath);
      return;
    }
  }
  if (fusionEnabled && individualResults.length > 0) {
    core.info(`Running fusion: ${fusionModel}`);
    try {
      const fusionResult = invokeOpenCode(
        composeFusionPrompt(individualResults),
        fusionModel,
        fusionConfigPath,
        {
          homeDir: fusionHomeDir,
          timeoutMinutes,
          disableTools: true,
          debugCapture: debugEnabled
            ? createDebugCapturePaths(debugDirectory, ++debugInvocation, 'fusion', fusionModel)
            : undefined,
        },
      );
      accountedResults.push(fusionResult);
      successfulModels.add(fusionModel);
      // Fusion also writes to the same file path; reread it after the call.
      try {
        reviewText = readReviewOutputFile(reviewOutputPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Fusion did not write the review file (${message}); using the model response text.`);
        reviewText = fusionResult.text;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`fusion :: ${fusionModel}: ${message}`);
      core.warning(`Fusion failed for ${fusionModel}; using all successful individual reviews: ${message}`);
    }
  }

  if (individualResults.length === 0) {
    core.warning('All review invocations failed; no review output was generated.');
    setEmptyOutputs();
  } else {
    const costByModel: Record<string, number> = {};
    const tokensByModel: Record<string, { input: number; output: number }> = {};
    let totalCost = 0;
    const totalTokens = { input: 0, output: 0 };

    for (const result of accountedResults) {
      totalCost += result.cost;
      totalTokens.input += result.tokens.input;
      totalTokens.output += result.tokens.output;
      costByModel[result.model] = (costByModel[result.model] ?? 0) + result.cost;
      const modelTokens = tokensByModel[result.model] ?? { input: 0, output: 0 };
      modelTokens.input += result.tokens.input;
      modelTokens.output += result.tokens.output;
      tokensByModel[result.model] = modelTokens;
    }

    core.setOutput('review', reviewText);
    core.setOutput('review-output-path', reviewOutputPath);
    core.setOutput('models-used', [...successfulModels].join(','));
    core.setOutput('cost', totalCost);
    core.setOutput('cost-by-model', JSON.stringify(costByModel));
    core.setOutput('tokens', JSON.stringify(totalTokens));
    core.setOutput('tokens-by-model', JSON.stringify(tokensByModel));
  }

  if (debugEnabled) {
    try {
      finalizeDebugDirectory(debugDirectory);
      core.setOutput('debug-artifact-path', debugDirectory);
    } catch (error) {
      fs.rmSync(debugDirectory, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      core.setFailed(`Failed to create redacted debug artifact: ${message}`);
      return;
    }
  }

  if (failures.length > 0 && failOnError) {
    core.setFailed(`${failures.length} review operation(s) failed`);
  }
}

run();
