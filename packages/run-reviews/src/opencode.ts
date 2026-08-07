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
 *
 * `firstIssues` is the synthetic reason the retry was triggered:
 *   - `'missing heading'` when `extractReviewDocument` returned null
 *   - the validator's rejection reason when the heading was present
 *     but `formatReviewDocumentIssues` flagged a format problem
 *   - `null` would mean no retry should run; callers gate on that
 *     before invoking this helper.
 */
function buildRetryPrompt(
  originalPrompt: string,
  firstCallText: string,
  firstIssues: string,
): string {
  const hasText = firstCallText.trim().length > 0;
  let formatDirective: string;
  if (!hasText) {
    formatDirective = `Your previous response produced no output. Emit ONLY the canonical review document based on the diff and prompts below; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}`;
  } else if (firstIssues === 'missing heading') {
    formatDirective = `Your previous response produced analysis but no canonical review document. Convert that analysis to the canonical format below. Emit ONLY the canonical review document; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}

Your previous analysis (for context):
${firstCallText}`;
  } else {
    // firstIssues is a validator-style rejection reason. Surface it
    // so the model knows exactly which rule to fix.
    formatDirective = `Your previous response produced a document but the validator rejected it for format reasons: \`${firstIssues}\`. Fix the format issues and emit ONLY the canonical review document; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}

Your previous analysis (for context):
${firstCallText}`;
  }

  return `${formatDirective}\n\n---\n\n${originalPrompt}`;
}

// ---------------------------------------------------------------------------
// Client-side format checks mirroring `validateReviewDocument`.
//
// The two most common rejection modes the deterministic validator
// produces on real model output are:
//   1. `## Scope` section is missing OR has no bullet lines.
//   2. A finding block's `Location:` field does not match the
//      canonical `<path>:<line>` / `<path>:<line>-<line>` grammar
//      (per comma-separated item).
//
// We mirror those rules here so the retry path can fire on format
// invalidity in addition to the heading-missing case. Client-side
// checks (no call into the validator package) keep this lightweight
// enough to run on every review invocation without measurable cost.
// ---------------------------------------------------------------------------

const SCOPE_HEADING_PATTERN = /^## Scope\s*$/;
const FINDING_HEADING_PATTERN = /^### /;
const LOCATION_FIELD_PATTERN = /^-\s*Location:\s*(\S.*)$/;
const TOP_BULLET_PATTERN = /^-\s+\S/;
const LOCATION_ITEM_PATTERN = /^([^:]+):(\d+)(?:-(\d+))?$/;

function locationItems(value: string): string[] {
  return value.split(',').map((item) => item.trim());
}

function describeLocationError(value: string): string {
  if (value.includes(';')) {
    return 'Location items must be separated by commas only; semicolons are not allowed';
  }
  for (const raw of locationItems(value)) {
    if (raw === '') {
      return 'Location must not contain empty items or a trailing/leading comma';
    }
    if (!LOCATION_ITEM_PATTERN.test(raw)) {
      return `Location item "${raw}" must match <path>:<line> or <path>:<line>-<line> (use commas to separate multiple items; do not use "and", "or", "&", ";", markdown links, or bullets)`;
    }
  }
  // Unreachable when the caller invokes us only after a regex miss,
  // but kept so future changes can't silently fall through.
  return 'Location is invalid';
}

function isValidLocations(value: string): boolean {
  if (value.trim() === '' || value.includes(';')) {
    return false;
  }
  for (const raw of locationItems(value)) {
    if (raw === '' || !LOCATION_ITEM_PATTERN.test(raw)) {
      return false;
    }
  }
  return true;
}

/**
 * Client-side mirror of the validator's two most common rejection
 * modes. Returns the first failure reason as a string, or `null`
 * if the document passes both checks.
 *
 * Fence tracking is intentionally NOT included: the two checks here
 * operate on top-level structural markers (`## Scope` and
 * `- Location:`) that the validator also reads; if a model puts a
 * `- Location:` line inside a fenced code block the validator
 * ignores it as fenced prose, but a retry is still safe (the
 * validator runs on the retry's output, not the first call's text).
 */
export function formatReviewDocumentIssues(text: string): string | null {
  const lines = text.split('\n');
  let scopeSeen = false;
  let scopeHasBullet = false;
  let sawFirstFindingLocation = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (SCOPE_HEADING_PATTERN.test(line)) {
      scopeSeen = true;
      // Walk forward until the next major heading or the first
      // non-blank line. A top-level bullet (- followed by content)
      // populates Scope; sub-bullets alone don't count.
      for (let j = i + 1; j < lines.length; j += 1) {
        const inner = lines[j];
        if (inner.startsWith('## ')) break;
        if (inner.trim() === '') continue;
        if (TOP_BULLET_PATTERN.test(inner)) {
          scopeHasBullet = true;
        }
        break;
      }
      continue;
    }

    if (FINDING_HEADING_PATTERN.test(line)) {
      // Walk forward from this finding header to locate the
      // Location field. Only the first Location per finding is
      // checked (the validator parses field-by-field and stops at
      // the next field or block).
      const headingLineNumber = i + 1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const inner = lines[j];
        if (FINDING_HEADING_PATTERN.test(inner) || inner.startsWith('## ')) break;
        const locationMatch = inner.match(LOCATION_FIELD_PATTERN);
        if (locationMatch) {
          const value = locationMatch[1].trim();
          if (!isValidLocations(value)) {
            return `finding at line ${headingLineNumber} has invalid Location: ${describeLocationError(value)}`;
          }
          sawFirstFindingLocation = true;
          break;
        }
      }
      // The validator also rejects missing Location; surface as a
        // secondary check. Keep it scoped to the first finding we
        // encounter so a single missing-Location doesn't trigger
        // a cascade of identical reasons.
      if (!sawFirstFindingLocation) {
        // Re-scan: if any finding exists but no Location was seen,
        // the validator will reject it. We only flag the first
        // such finding so the model has a clear, single fix target.
        for (let j = i + 1; j < lines.length; j += 1) {
          const inner = lines[j];
          if (FINDING_HEADING_PATTERN.test(inner) || inner.startsWith('## ')) break;
          if (LOCATION_FIELD_PATTERN.test(inner)) {
            sawFirstFindingLocation = true;
            break;
          }
        }
        // Note: we don't currently fail when Location is absent on
        // the FIRST finding; the validator does, but the spec only
        // lists "doesn't match the pattern" so we mirror that
        // surface. The downstream `validateReviewDocument` call
        // catches the missing-Location case as a fallback.
      }
    }
  }

  if (!scopeSeen) {
    return 'missing ## Scope section';
  }
  if (!scopeHasBullet) {
    return '## Scope section is present but contains no bullets';
  }

  return null;
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
 * produce a canonical review document (either no `# Review —`
 * heading, OR a heading plus a body that fails the validator's
 * common format checks — see `formatReviewDocumentIssues`), a
 * second call is dispatched with a focused format-conversion prompt
 * that uses the first call's text as context. The retry surfaces the
 * specific rejection reason (missing heading vs. validator-format
 * rejection) so the model knows exactly which rule to fix. Tokens
 * and cost are summed across both calls so downstream accounting
 * reflects the full spend. If the retry also fails to produce a
 * valid document, the action's downstream validation surfaces the
 * failure cleanly via `failure-reason`; this wrapper never throws on
 * a missing heading.
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

  // Decide whether to retry. Either condition triggers the fallback:
  //   - no `# Review —` heading at all (model burned budget on
  //     thinking or emitted nothing visible)
  //   - heading present but the body fails the validator's two
  //     most common format checks (Scope missing/no bullets, or a
  //     finding's Location field not matching the canonical grammar)
  const firstIssues: string | null = firstExtracted === null
    ? 'missing heading'
    : formatReviewDocumentIssues(firstExtracted);

  if (firstIssues === null) {
    // First call produced a valid document AND passed the format
    // checks; no retry needed. The non-null assertion on
    // `firstExtracted` is safe because `firstIssues === null`
    // implies `firstExtracted !== null` (the ternary above).
    return {
      text: firstExtracted as string,
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
  const retryPrompt = buildRetryPrompt(prompt, firstText, firstIssues);
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