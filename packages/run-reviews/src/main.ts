import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';
import {
  mergeReviewDocuments,
  validateReviewDocument,
} from '@jander99/ai-review-review-contract';
import { fetchPriorReviews } from '@jander99/ai-review-previous-reviews';
import {
  buildAgentDefinition,
  buildValidatorAgentDefinition,
  getEventContext,
  titleOrRefForHeading,
} from './agent-definition';
import { buildFusionConfig, buildMergedConfig, buildValidatorConfig } from './config-builder';
import { composeFusionPrompt } from './fusion';
import { invokeOpenCode } from './opencode';
import type { DebugCapturePaths } from './opencode';
import { parsePrompts, composeTaskPromptWithPreviousReviews } from './prompt-composer';
import type { Permission, PromptEntry, ReviewResult } from './types';

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
  document: string;
}

function writeReviewOutputFile(targetPath: string, content: string): void {
  // The action is the authoritative source of the review file. The model
  // emits the structured review markdown in its reply; the action captures
  // the reply text, validates it, and writes the canonical document so
  // the structural validator and the publishing step both read the same
  // file.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, { encoding: 'utf8', mode: 0o600 });
}

function readReviewOutputFile(targetPath: string): string {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`review output file not found at ${targetPath}`);
  }
  const content = fs.readFileSync(targetPath, 'utf8');
  if (!content.trim()) {
    throw new Error(`review output file at ${targetPath} is empty`);
  }
  return content;
}

function compareLexically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseRepository(repository: string | undefined): { owner: string; repo: string } | null {
  if (!repository) {
    return null;
  }
  const slashIndex = repository.indexOf('/');
  if (slashIndex <= 0 || slashIndex === repository.length - 1) {
    return null;
  }
  return {
    owner: repository.slice(0, slashIndex),
    repo: repository.slice(slashIndex + 1),
  };
}

/**
 * Options consumed by the programmatic review pipeline. Callers MUST
 * supply every input as a field on this object; the function does not
 * touch `core` directly. The standalone action wrapper translates
 * `@actions/core` inputs into this shape.
 */
export interface RunReviewsOptions {
  opencodeVersion: string;
  debug: boolean;
  model: string;
  modelsInput: string;
  fusionEnabled: boolean;
  fusionModel: string;
  failOnError: boolean;
  timeoutMinutes: number;
  prompts: string;
  permission: Permission;
  userConfig?: string;
  githubToken?: string;
}

/**
 * Result of the programmatic review pipeline. Mirrors the action
 * outputs so the standalone action wrapper can write them via
 * `core.setOutput` and the root action can use them as plain fields.
 */
export interface RunReviewsResult {
  review: string;
  reviewOutputPath: string;
  modelsUsed: string;
  cost: number;
  costByModel: Record<string, number>;
  tokens: { input: number; output: number };
  tokensByModel: Record<string, { input: number; output: number }>;
  configJson: string;
  effectiveModel: string;
  debugArtifactPath: string;
  failureReason: string;
}

export async function runReviews(options: RunReviewsOptions): Promise<RunReviewsResult> {
  const empty: RunReviewsResult = {
    review: '',
    reviewOutputPath: '',
    modelsUsed: '',
    cost: 0,
    costByModel: {},
    tokens: { input: 0, output: 0 },
    tokensByModel: {},
    configJson: '',
    effectiveModel: '',
    debugArtifactPath: '',
    failureReason: '',
  };

  try {
    assertOpenCodeVersion(options.opencodeVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, failureReason: `OpenCode version assertion failed: ${message}` };
  }

  const validResults: IndividualReviewResult[] = [];
  const accountedResults: ReviewResult[] = [];
  const successfulModels = new Set<string>();
  const failures: string[] = [];
  let prompts: PromptEntry[];
  let effectiveModels: string[];
  let fusionModel: string;
  let configPath: string;
  let homeDir: string;
  let serializedConfig = '';
  let fusionConfigPath = '';
  let fusionHomeDir = '';
  let debugDirectory = '';
  let debugInvocation = 0;
  let priorReviewsBlock: string | null = null;
  let eventContextForSetup: ReturnType<typeof getEventContext>;
  let failureMessage: string | null = null;

  try {
    if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
      throw new Error('timeout-minutes must be a positive integer');
    }

    const parsedModels = options.modelsInput
      ? options.modelsInput
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [options.model];
    effectiveModels = [...new Set(parsedModels)];
    if (effectiveModels.length === 0) {
      throw new Error('At least one model is required');
    }

    fusionModel = options.fusionModel || effectiveModels[0];
    prompts = parsePrompts(options.prompts);
    eventContextForSetup = getEventContext();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, failureReason: `Review setup failed: ${message}` };
  }

  if (eventContextForSetup.eventName === 'pull_request' && eventContextForSetup.prNumber) {
    const parsedRepo = parseRepository(eventContextForSetup.repository);
    if (parsedRepo) {
      try {
        const fetched = await fetchPriorReviews({
          token: options.githubToken || undefined,
          owner: parsedRepo.owner,
          repo: parsedRepo.repo,
          issueNumber: eventContextForSetup.prNumber,
        });
        if (fetched) {
          priorReviewsBlock = fetched.combined;
          console.log(`Loaded ${fetched.comments.length} prior AI review comment(s) for #${eventContextForSetup.prNumber}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Prior review fetch failed; proceeding without prior context: ${message}`);
      }
    }
  }

  try {
    const agent = buildAgentDefinition({
      eventContext: eventContextForSetup,
      priorReviewsBlock,
    });
    const merged = buildMergedConfig({
      userConfig: options.userConfig,
      permission: options.permission,
      agent,
      model: effectiveModels[0],
    });
    configPath = merged.configPath;
    homeDir = merged.homeDir;
    serializedConfig = merged.serializedConfig;
    if (options.fusionEnabled) {
      const fusion = buildFusionConfig({
        agent,
        model: fusionModel,
      });
      fusionConfigPath = fusion.configPath;
      fusionHomeDir = fusion.homeDir;
    }
    if (options.debug) {
      debugDirectory = createDebugDirectory();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, failureReason: `Review setup failed: ${message}` };
  }

  const orderedPrompts = [...prompts].sort((left, right) => compareLexically(left.source, right.source));
  const orderedModels = [...effectiveModels].sort(compareLexically);

  const reviewOutputPath = eventContextForSetup.reviewOutputPath;
  if (!reviewOutputPath) {
    return { ...empty, failureReason: 'review output path could not be determined for this event' };
  }

  const validatorConfig = buildValidatorConfig({
    model: effectiveModels[0],
    validatorAgent: buildValidatorAgentDefinition(),
    userConfig: options.userConfig,
  });

  for (const prompt of orderedPrompts) {
    for (const currentModel of orderedModels) {
      console.log(`Running review: ${currentModel} :: ${prompt.source}`);
      try {
        const result = invokeOpenCode(
          composeTaskPromptWithPreviousReviews([prompt], priorReviewsBlock),
          currentModel,
          configPath,
          {
            homeDir,
            timeoutMinutes: options.timeoutMinutes,
            debugCapture: options.debug
              ? createDebugCapturePaths(debugDirectory, ++debugInvocation, 'review', currentModel)
              : undefined,
          },
        );
        accountedResults.push(result);
        successfulModels.add(currentModel);
        const validation = validateReviewDocument(result.text);
        if (!validation.valid) {
          failures.push(
            `${currentModel} :: ${prompt.source}: invalid review document (${validation.reason})`,
          );
          console.warn(
            `Review from ${currentModel} :: ${prompt.source} is structurally invalid: ${validation.reason}`,
          );
          continue;
        }
        validResults.push({ ...result, prompt: prompt.source, document: result.text });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${currentModel} :: ${prompt.source}: ${message}`);
        console.warn(`Review failed for ${currentModel} :: ${prompt.source}: ${message}`);
      }
    }
  }

  const titleOrRef = titleOrRefForHeading(eventContextForSetup);
  let canonicalDocument: string | undefined;
  let reviewText = '';

  if (validResults.length === 0) {
    if (accountedResults.length === 0) {
      failureMessage = `all ${failures.length} review invocation(s) failed before producing a document`;
    } else {
      failureMessage =
        `all ${accountedResults.length} review invocation(s) produced invalid documents`;
    }
  } else {
    if (options.fusionEnabled && validResults.length > 1) {
      console.log(`Running fusion: ${fusionModel}`);
      try {
        const agent = buildAgentDefinition({
          eventContext: eventContextForSetup,
          priorReviewsBlock,
        });
        const fusionResult = invokeOpenCode(
          composeFusionPrompt(
            validResults.map((entry) => ({ model: entry.model, prompt: entry.prompt, text: entry.document })),
            agent.synthesis.prompt,
          ),
          fusionModel,
          fusionConfigPath,
          {
            homeDir: fusionHomeDir,
            timeoutMinutes: options.timeoutMinutes,
            disableTools: true,
            debugCapture: options.debug
              ? createDebugCapturePaths(debugDirectory, ++debugInvocation, 'fusion', fusionModel)
              : undefined,
          },
        );
        accountedResults.push(fusionResult);
        successfulModels.add(fusionModel);
        const validation = validateReviewDocument(fusionResult.text);
        if (!validation.valid) {
          failures.push(`fusion :: ${fusionModel}: invalid fused review (${validation.reason})`);
          console.warn(
            `Fusion result from ${fusionModel} is structurally invalid: ${validation.reason}; falling back to deterministic merge.`,
          );
        } else {
          canonicalDocument = fusionResult.text;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`fusion :: ${fusionModel}: ${message}`);
        console.warn(`Fusion failed for ${fusionModel}; falling back to deterministic merge: ${message}`);
      }
    }

    if (canonicalDocument === undefined) {
      if (validResults.length === 1) {
        canonicalDocument = validResults[0].document;
      } else {
        canonicalDocument = mergeReviewDocuments(
          validResults.map((entry) => entry.document),
          titleOrRef,
        );
      }
    }

    try {
      writeReviewOutputFile(reviewOutputPath, canonicalDocument);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failureMessage = failureMessage ?? `Review output file write failed: ${message}`;
    }

    if (failureMessage === null) {
      try {
        reviewText = readReviewOutputFile(reviewOutputPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failureMessage = failureMessage ?? `Review output file read failed: ${message}`;
      }
    }
  }

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

  let debugArtifactPath = '';
  if (options.debug && debugDirectory) {
    try {
      finalizeDebugDirectory(debugDirectory);
      debugArtifactPath = debugDirectory;
    } catch (error) {
      fs.rmSync(debugDirectory, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      failureMessage = failureMessage ?? `Failed to create redacted debug artifact: ${message}`;
    }
  }

  let resolvedFailureReason = failureMessage ?? '';
  if (!resolvedFailureReason && failures.length > 0 && options.failOnError) {
    resolvedFailureReason = `${failures.length} review operation(s) failed`;
  }

  return {
    review: reviewText,
    reviewOutputPath,
    modelsUsed: [...successfulModels].join(','),
    cost: totalCost,
    costByModel,
    tokens: totalTokens,
    tokensByModel,
    configJson: validatorConfig.serializedConfig,
    effectiveModel: effectiveModels[0],
    debugArtifactPath,
    failureReason: resolvedFailureReason,
  };
}