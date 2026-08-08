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
 * `firstIssues` is the list of reasons the retry was triggered:
 *   - empty array means "first call passed all checks, no retry"
 *     (callers gate on `firstIssues.length > 0` before invoking)
 *   - non-empty when `extractReviewDocument` returned null (synthetic
 *     `['missing heading']`) OR when `formatReviewDocumentIssues`
 *     surfaced one or more validator-style rejection reasons
 *
 * When `firstIssues` has multiple entries (the common case after a
 * multi-issue document like the claude #31226995889 run), the
 * directive surfaces them as a numbered list so the model fixes
 * every issue in one retry instead of leaking one at a time.
 */
function buildRetryPrompt(
  originalPrompt: string,
  firstCallText: string,
  firstIssues: string[],
): string {
  const hasText = firstCallText.trim().length > 0;
  let formatDirective: string;
  if (!hasText) {
    formatDirective = `Your previous response produced no output. Emit ONLY the canonical review document based on the diff and prompts below; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}`;
  } else if (firstIssues.length === 1 && firstIssues[0] === 'missing heading') {
    formatDirective = `Your previous response produced analysis but no canonical review document. Convert that analysis to the canonical format below. Emit ONLY the canonical review document; begin with "# Review — " on the very first character.

${CANONICAL_FORMAT_TEMPLATE}

Your previous analysis (for context):
${firstCallText}`;
  } else {
    // Format-issue case: list every validator reason the helper
    // surfaced (typically 1-3 entries) so the model fixes them all
    // in this retry instead of round-tripping the cycle again.
    const issueList = firstIssues
      .map((reason, idx) => `  ${idx + 1}. ${reason}`)
      .join('\n');
    formatDirective = `Your previous response produced a document but the validator rejected it for the following format reasons:
${issueList}

Convert your analysis to the canonical format below and emit ONLY the canonical review document; begin with "# Review — " on the very first character. Address every issue above in your retry.

${CANONICAL_FORMAT_TEMPLATE}

Your previous analysis (for context):
${firstCallText}`;
  }

  return `${formatDirective}\n\n---\n\n${originalPrompt}`;
}

// ---------------------------------------------------------------------------
// Client-side format checks mirroring `validateReviewDocument`.
//
// The validator's most common rejection modes on real model output:
//   1. `## Scope` section is missing OR has no bullet lines.
//   2. A finding block's `Location:` field does not match the
//      canonical `<path>:<line>` / `<path>:<line>-<line>` grammar
//      (per comma-separated item).
//   3. The `## Summary` integer fields don't match the counts derived
//      from `## Findings` blocks (status -> count).
//
// We mirror those rules here so the retry path can fire on format
// invalidity in addition to the heading-missing case. ALL issues
// found in one pass are returned (in validator order); the retry
// prompt surfaces them as a numbered list so the model addresses
// every issue in a single retry. Client-side checks (no call into
// the validator package) keep this lightweight enough to run on
// every review invocation without measurable cost.
// ---------------------------------------------------------------------------

const SCOPE_HEADING_PATTERN = /^## Scope\s*$/;
const FINDING_HEADING_PATTERN = /^### /;
const LOCATION_FIELD_PATTERN = /^-\s*Location:\s*(\S.*)$/;
const STATUS_FIELD_PATTERN = /^-\s*Status:\s*(.+)$/i;
const SUMMARY_HEADING_PATTERN = /^## Summary\s*$/;
const TOP_BULLET_PATTERN = /^-\s+\S/;
const LOCATION_ITEM_PATTERN = /^([^:]+):(\d+)(?:-(\d+))?$/;
// Matches the three `## Summary` integer lines. Each accepts the
// leading `-`, optional whitespace, and an integer capture. The
// regex mirrors the validator's `parseSummary` shape.
const NEW_FINDINGS_PATTERN = /^\s*-\s*New findings:\s*(\d+)\s*$/;
const UNRESOLVED_PATTERN = /^\s*-\s*Unresolved from prior review:\s*(\d+)\s*$/;
const RESOLVED_PATTERN = /^\s*-\s*Resolved by latest commits:\s*(\d+)\s*$/;
// Mirrors the validator's strict `## Summary` shape: each bullet
// must be exactly `- <field>: <integer>` with no trailing text.
// Models that emit parenthetical reasoning inline
// (e.g. `- Resolved by latest commits: 1 (validator fixed b)`)
// trigger the validator's `unexpected content in ## Summary`
// rejection; the retry directive surfaces this so the model drops
// the parenthetical.
const SUMMARY_CONTENT_NEW = /^- New findings:\s*\d+\s*$/;
const SUMMARY_CONTENT_UNRESOLVED = /^- Unresolved from prior review:\s*\d+\s*$/;
const SUMMARY_CONTENT_RESOLVED = /^- Resolved by latest commits:\s*\d+\s*$/;
// A `-` line in the Summary section that fails to match any of
// the three strict patterns above. Used by the Summary-content
// check below.
const SUMMARY_BULLET_PREFIX = /^\s*-\s*/;
// Mirrors `STATUS_COUNTS_AS_NEW` in the contract: `new` and
// `new variant` both count toward New findings.
const NEW_STATUSES = new Set(['new', 'new variant']);

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

interface FindingStub {
  /** Line number (1-indexed) of the `### …` heading. */
  lineNumber: number;
  /** Lowercased Status field value (e.g. `new`, `new variant`, `unresolved`). */
  status: string;
  /** Raw Location field value (may be invalid). */
  locationValue: string;
  /** Whether the Location field matches the canonical grammar. */
  locationValid: boolean;
  /** Human-readable Location error, populated when `locationValid` is false. */
  locationError: string | null;
}

/**
 * Walk `### …` finding blocks and collect one `FindingStub` per
 * block. Scope-bullets / Summary-count checks happen elsewhere; this
 * helper only extracts finding metadata for the Location + count
 * checks.
 */
function extractFindings(lines: string[]): FindingStub[] {
  const findings: FindingStub[] = [];
  let current: FindingStub | null = null;
  const pushCurrent = (): void => {
    if (current) {
      findings.push(current);
      current = null;
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FINDING_HEADING_PATTERN.test(line)) {
      pushCurrent();
      current = {
        lineNumber: i + 1,
        status: '',
        locationValue: '',
        locationValid: true,
        locationError: null,
      };
      continue;
    }
    if (line.startsWith('## ')) {
      pushCurrent();
      continue;
    }
    if (!current) continue;
    const statusMatch = line.match(STATUS_FIELD_PATTERN);
    if (statusMatch) {
      current.status = statusMatch[1].trim().toLowerCase();
      continue;
    }
    const locMatch = line.match(LOCATION_FIELD_PATTERN);
    if (locMatch) {
      current.locationValue = locMatch[1].trim();
      if (!isValidLocations(current.locationValue)) {
        current.locationValid = false;
        current.locationError = describeLocationError(current.locationValue);
      }
    }
  }
  pushCurrent();
  return findings;
}

/**
 * Walk the `## Summary` section and extract the three integers.
 * Returns `null` when any of the three fields is missing (the
 * validator will reject the document for a separate reason; we
 * simply cannot compute counts to compare).
 */
function extractSummaryCounts(lines: string[]): { new: number; unresolved: number; resolved: number } | null {
  const summaryIdx = lines.findIndex((l) => SUMMARY_HEADING_PATTERN.test(l));
  if (summaryIdx === -1) return null;

  let newCount: number | null = null;
  let unresolvedCount: number | null = null;
  let resolvedCount: number | null = null;

  for (let i = summaryIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // Stop at the next finding block or major heading.
    if (FINDING_HEADING_PATTERN.test(line) || /^\s*##\s+/.test(line)) {
      break;
    }
    const newMatch = line.match(NEW_FINDINGS_PATTERN);
    if (newMatch) {
      newCount = Number.parseInt(newMatch[1], 10);
      continue;
    }
    const unresolvedMatch = line.match(UNRESOLVED_PATTERN);
    if (unresolvedMatch) {
      unresolvedCount = Number.parseInt(unresolvedMatch[1], 10);
      continue;
    }
    const resolvedMatch = line.match(RESOLVED_PATTERN);
    if (resolvedMatch) {
      resolvedCount = Number.parseInt(resolvedMatch[1], 10);
    }
  }

  if (newCount === null || unresolvedCount === null || resolvedCount === null) {
    return null;
  }
  return { new: newCount, unresolved: unresolvedCount, resolved: resolvedCount };
}

/**
 * Client-side mirror of the validator's most common rejection modes.
 * Returns the issues found in the order the validator would
 * encounter them (Scope first, then per-finding Location issues in
 * document order, then the Summary count mismatch, then the Summary
 * strict-shape check). Empty array means the document passes all
 * checks.
 *
 * Fence tracking is intentionally NOT included: the checks operate
 * on top-level structural markers (`## Scope`, `- Location:`,
 * `## Summary`, `### `) that the validator also reads; if a model
 * puts a `- Location:` line inside a fenced code block the
 * validator ignores it as fenced prose, but a retry is still safe
 * (the validator runs on the retry's output, not the first call's
 * text). False positives are cheap; missed checks leak through.
 */
export function formatReviewDocumentIssues(text: string): string[] {
  const lines = text.split('\n');
  const issues: string[] = [];

  // ----- 1. ## Scope check: present and at least one top-level bullet. -----
  const scopeIdx = lines.findIndex((l) => SCOPE_HEADING_PATTERN.test(l));
  if (scopeIdx === -1) {
    issues.push('missing ## Scope section');
  } else {
    let scopeHasBullet = false;
    for (let j = scopeIdx + 1; j < lines.length; j += 1) {
      const inner = lines[j];
      if (inner.startsWith('## ')) break;
      if (inner.trim() === '') continue;
      if (TOP_BULLET_PATTERN.test(inner)) {
        scopeHasBullet = true;
      }
      break; // first non-blank content determines pass/fail
    }
    if (!scopeHasBullet) {
      issues.push('## Scope section is present but contains no bullets');
    }
  }

  // ----- 2. Per-finding Location validity. -----
  const findings = extractFindings(lines);
  for (const finding of findings) {
    if (!finding.locationValid && finding.locationError !== null) {
      issues.push(`finding at line ${finding.lineNumber} has invalid Location: ${finding.locationError}`);
    }
  }

  // ----- 3. Summary-count mismatch with finding Status counts. -----
  const summary = extractSummaryCounts(lines);
  if (summary !== null) {
    const actual = { new: 0, unresolved: 0, resolved: 0 };
    for (const finding of findings) {
      if (NEW_STATUSES.has(finding.status)) {
        actual.new += 1;
      } else if (finding.status === 'unresolved') {
        actual.unresolved += 1;
      } else if (finding.status === 'resolved') {
        actual.resolved += 1;
      }
    }
    if (
      actual.new !== summary.new
      || actual.unresolved !== summary.unresolved
      || actual.resolved !== summary.resolved
    ) {
      issues.push(
        `count mismatch: summary says New=${summary.new}, Unresolved=${summary.unresolved}, Resolved=${summary.resolved}; blocks yield New=${actual.new}, Unresolved=${actual.unresolved}, Resolved=${actual.resolved}`,
      );
    }
  }
  // If Summary is missing or incomplete, `extractSummaryCounts`
  // returns null; the downstream `validateReviewDocument` call
  // catches that as a separate rejection mode.

  // ----- 4. Summary strict-shape check. -----
  // The validator's `parseSummary` only matches `- <field>: <integer>`
  // bullets with no trailing text. Models that emit parenthetical
  // reasoning inline (e.g. `- Resolved by latest commits: 1
  // (validator fixed b)`) cause the validator to reject with
  // `unexpected content in ## Summary: <line>`. Walk every `-`
  // bullet in the Summary section; anything that doesn't match one
  // of the three strict patterns gets flagged here.
  const summaryIdx = lines.findIndex((l) => SUMMARY_HEADING_PATTERN.test(l));
  if (summaryIdx !== -1) {
    for (let i = summaryIdx + 1; i < lines.length; i += 1) {
      const line = lines[i];
      // Stop at the next major heading or finding block (Summary
      // is followed by ## Findings when present).
      if (FINDING_HEADING_PATTERN.test(line) || /^\s*##\s+/.test(line)) {
        break;
      }
      // Only `-` lines are bullets; skip blank lines and prose.
      if (!SUMMARY_BULLET_PREFIX.test(line)) continue;
      // The line is a `-` bullet; it must match one of the three
      // strict integer patterns exactly. A trailing parenthetical,
      // extra bullet, or wrong field name all fail.
      if (
        !SUMMARY_CONTENT_NEW.test(line)
        && !SUMMARY_CONTENT_UNRESOLVED.test(line)
        && !SUMMARY_CONTENT_RESOLVED.test(line)
      ) {
        issues.push(`unexpected content in ## Summary: ${line}`);
      }
    }
  }

  return issues;
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
 * heading, OR a heading plus a body that fails one or more of the
 * validator's common format checks — see `formatReviewDocumentIssues`),
 * a second call is dispatched with a focused format-conversion
 * prompt that uses the first call's text as context. The retry
 * surfaces EVERY issue found (Scope + per-finding Location + count
 * mismatch), formatted as a numbered list, so the model fixes them
 * all in one retry instead of leaking one at a time. Tokens and
 * cost are summed across both calls so downstream accounting
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
  //   - heading present but the body fails one or more of the
  //     validator's most common format checks (Scope missing/no
  //     bullets, a finding's Location field not matching the
  //     canonical grammar, or Summary counts mismatching the
  //     finding Status counts)
  //
  // `firstIssues` lists EVERY issue found in validator order; the
  // retry directive surfaces them as a numbered list so the model
  // fixes them all in one retry instead of leaking one at a time.
  const firstIssues: string[] = firstExtracted === null
    ? ['missing heading']
    : formatReviewDocumentIssues(firstExtracted);

  if (firstIssues.length === 0) {
    // First call produced a valid document AND passed the format
    // checks; no retry needed. The non-null assertion on
    // `firstExtracted` is safe because `firstIssues.length === 0`
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