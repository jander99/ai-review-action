import { extractReviewDocument } from '@jander99/ai-review-review-contract';
import type { ReviewResult } from './types';
import {
  runReview,
  type DebugCapturePaths,
  type ReviewRuntime,
  type ReviewRuntimeResult,
  type ReviewRuntimeSpawn,
  type ReviewTool,
} from './runtime';
import { OpenCodeRuntime } from './opencode-run';
import { ClaudeCodeRuntime } from './claude-run';

export type { DebugCapturePaths } from './runtime';
export type { ReviewTool, ReviewRuntime } from './runtime';

export interface InvokeReviewOptions {
  homeDir: string;
  timeoutMinutes?: number;
  disableTools?: boolean;
  debugCapture?: DebugCapturePaths;
  /**
   * Kept for public API compatibility. The selected agent is read from the
   * merged OpenCode config by the one-shot CLI invocation.
   */
  agent?: string;
}

/**
 * Optional dependency-injection seam for `invokeOpenCode` / `invokeReview`.
 * Mirrors the pattern used by `runOpenCodeRun`: callers can pass a custom
 * `spawn` to script the OpenCode CLI in tests. The 4/5-argument form is the
 * documented public surface; the optional runtime argument is a non-breaking
 * extension used by the test suite and any future test fixtures.
 */
export type InvokeOpenCodeRuntime = ReviewRuntimeSpawn;

// Re-export the opencode-specific InvokeOpenCodeOptions shape as an
// alias of InvokeReviewOptions for back-compat with callers that
// imported the original name. The dispatcher ignores opencode-only
// fields when running with tool='claude'.
export type InvokeOpenCodeOptions = InvokeReviewOptions;

function resolveRuntime(tool: ReviewTool): ReviewRuntime {
  return tool === 'claude' ? new ClaudeCodeRuntime() : new OpenCodeRuntime();
}

/**
 * Canonical review-document shape, inlined as a focused format
 * directive for the retry call. The retry's job is to take whatever
 * analysis the first call produced (or the raw diff+prompts, when the
 * first call returned nothing) and emit a strict canonical document
 * that begins with `# Review — `. Repeating the shape here keeps the
 * retry prompt self-contained: the model does not have to remember
 * the full original system prompt in order to follow the contract.
 *
 * Mirrors the shape described in `REVIEW_AGENT_PROMPT_TEMPLATE` and
 * enforced by `validateReviewDocument` in the review contract.
 */
const CANONICAL_FORMAT_TEMPLATE = `# Review — <title>

## Scope
- <one or more bullet lines, each non-empty>

## Summary
- New findings: <integer>
- Unresolved from prior review: <integer>
- Resolved by latest commits: <integer>

## Findings (only when there are findings; max 5 blocks)
### 🔴 Critical — <short title>
- Status: <new | unresolved | resolved | new variant>
- Location: <path>:<line>
- Description: <single-line text, max 200 chars>

(repeat the finding block for each finding; omit the section entirely when there are no findings)`;

/**
 * Build the retry prompt that focuses the second call on format
 * conversion. The first call's output is passed in as context when
 * present; when the first call returned no text the retry gets the
 * full directive plus the original prompt (with the embedded diff)
 * so it can still produce a review.
 */
function buildRetryPrompt(originalPrompt: string, firstCallText: string): string {
  const formatDirective = firstCallText.trim()
    ? `Your previous response produced analysis but no canonical review document. Convert that analysis to the canonical format below. Emit ONLY the canonical review document; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}

Your previous analysis (for context):
${firstCallText}`
    : `Your previous response produced no output. Emit ONLY the canonical review document based on the diff and prompts below; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}`;

  return `${formatDirective}\n\n---\n\n${originalPrompt}`;
}

/**
 * Sum the tokens and cost of two reviewer invocations into the shape
 * `ReviewResult` expects. The `reasoning` field on the per-call
 * result is intentionally dropped: `ReviewResult.tokens` does not
 * surface it and the contract validator does not require it.
 */
function combineResults(first: ReviewRuntimeResult, second: ReviewRuntimeResult): ReviewResult['tokens'] {
  return {
    input: first.tokens.input + second.tokens.input,
    output: first.tokens.output + second.tokens.output,
  };
}

/**
 * Run a single reviewer invocation through the selected runtime.
 * Internal helper that does NOT trigger the format fallback - the
 * caller decides whether to retry.
 *
 * The retry path always passes `undefined` for `debugCapture` so the
 * first call's captured analysis is the only artifact on disk. The
 * retry either succeeds (a canonical review emerges) or fails
 * (downstream validation surfaces a `failure-reason`); either way
 * the retry's raw streams are not interesting enough to warrant a
 * separate debug artifact.
 */
async function runOnce(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeReviewOptions,
  debugCapture: DebugCapturePaths | undefined,
  runtime: ReviewRuntime,
  spawnOverride: ReviewRuntimeSpawn | undefined,
): Promise<ReviewRuntimeResult> {
  const callOptions = {
    configPath,
    homeDir: options.homeDir,
    model,
    prompt,
    timeoutMinutes: options.timeoutMinutes ?? 30,
    disableTools: options.disableTools,
    debugCapture,
  };
  return runReview(callOptions, runtime, spawnOverride?.spawn);
}

/**
 * Invoke the selected reviewer CLI through the shared `runReview`
 * transport. Picks the OpenCode CLI (`opencode run --format=json`) for
 * `tool: 'opencode'` and the Claude Code CLI (`claude -p
 * --output-format stream-json`) for `tool: 'claude'`.
 *
 * The transport owns process and stream handling; this wrapper
 * preserves the review pipeline's sanitization and canonical document
 * extraction regardless of which CLI produced the events.
 *
 * Two-call retry strategy: when the first call's output does not
 * begin with a `# Review — <title-or-ref>` heading (e.g. the model
 * burned its output budget on `<think>` blocks and emitted nothing
 * visible, or stopped without producing the heading), a second call
 * is dispatched with a focused format-conversion prompt that uses
 * the first call's text as context. Tokens and cost are summed
 * across both calls so downstream accounting reflects the full
 * spend. If the retry also fails to produce a valid heading, the
 * action's downstream validation surfaces the failure cleanly via
 * `failure-reason`; this wrapper never throws on a missing heading.
 *
 * The optional 6th argument is a non-breaking extension for tests
 * that script the underlying CLI spawn. Existing callers that pass
 * only 5 arguments keep working unchanged.
 */
export async function invokeReview(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeReviewOptions,
  tool: ReviewTool,
  runtime?: ReviewRuntimeSpawn,
): Promise<ReviewResult> {
  const runtimeImpl = resolveRuntime(tool);

  const firstResult = await runOnce(
    prompt, model, configPath, options,
    options.debugCapture,
    runtimeImpl,
    runtime,
  );
  const firstText = firstResult.text;
  const firstExtracted = extractReviewDocument(firstText);
  if (firstExtracted !== null) {
    // First call produced a valid document; no retry needed.
    return {
      text: firstExtracted,
      tokens: { input: firstResult.tokens.input, output: firstResult.tokens.output },
      cost: firstResult.cost,
      model: firstResult.model,
    };
  }

  // First call did not produce a canonical document. Retry with a
  // focused format-conversion prompt that uses the first call's
  // text as context. Pass `undefined` for the retry's debug capture
  // so the first call's analysis is the only artifact captured; the
  // retry is either a fix or a known failure that downstream
  // validation will surface.
  const retryPrompt = buildRetryPrompt(prompt, firstText);
  const secondResult = await runOnce(
    retryPrompt, model, configPath, options,
    undefined,
    runtimeImpl,
    runtime,
  );
  const secondExtracted = extractReviewDocument(secondResult.text);

  return {
    // If the retry still has no heading, fall through to the raw text
    // so downstream validation (`validateReviewDocument` in the
    // review contract) can surface a clean failure via `failure-reason`
    // rather than this wrapper swallowing it.
    text: secondExtracted ?? secondResult.text,
    tokens: combineResults(firstResult, secondResult),
    cost: firstResult.cost + secondResult.cost,
    model: secondResult.model,
  };
}

/**
 * Back-compat thin wrapper around `invokeReview` that pins the
 * OpenCode runtime. Preserved so existing internal callers continue
 * to work without modification; new code should call `invokeReview`
 * directly with an explicit `tool` argument.
 *
 * The optional 5th argument is preserved from PR #36's
 * dependency-injection seam: callers (and the test suite) can pass
 * a custom `spawn` to script the OpenCode CLI. Existing 4-argument
 * callers keep working unchanged.
 */
export async function invokeOpenCode(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeOpenCodeOptions,
  runtime?: InvokeOpenCodeRuntime,
): Promise<ReviewResult> {
  return invokeReview(prompt, model, configPath, options, 'opencode', runtime);
}