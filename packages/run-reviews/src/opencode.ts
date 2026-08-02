import * as fs from 'fs';
import * as path from 'path';
import { extractReviewDocument, sanitizeModelText } from '@jander99/ai-review-review-contract';
import type { ReviewResult } from './types';
import { runOpenCodeServer, type DebugCapturePaths } from './opencode-server';

// Re-export the runtime types so callers that build higher-level
// orchestrators (or test doubles) do not need to import the transport
// module twice.
export type { DebugCapturePaths } from './opencode-server';

export interface InvokeOpenCodeOptions {
  homeDir: string;
  timeoutMinutes?: number;
  disableTools?: boolean;
  debugCapture?: DebugCapturePaths;
  /**
   * Optional override for the `agent` field on `POST /session/:id/message`.
   * When omitted, the server falls back to the `default_agent` declared in
   * the merged config.
   */
  agent?: string;
}

/**
 * Drive a single OpenCode invocation through the documented HTTP
 * server transport. Thin wrapper around `runOpenCodeServer` that
 * preserves the legacy synchronous-looking signature by returning a
 * Promise. Callers should `await` the result.
 *
 * The capture race that previously lost the final `text` part to the
 * `opencode run --format json` stream's maxBuffer flush is fixed at
 * the source: the server's `POST /session/:id/message` is
 * synchronous and returns the terminal assistant message atomically.
 *
 * Public API preserved: `invokeOpenCode(prompt, model, configPath,
 * options)` returning `{ text, tokens, cost, model }`.
 */
export async function invokeOpenCode(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeOpenCodeOptions,
): Promise<ReviewResult> {
  fs.mkdirSync(options.homeDir, { recursive: true });

  const result = await runOpenCodeServer({
    configPath,
    homeDir: options.homeDir,
    model,
    prompt,
    timeoutMinutes: options.timeoutMinutes ?? 30,
    permission: {},
    opencodeVersion: '',
    disableTools: options.disableTools,
    debugCapture: options.debugCapture,
    agent: options.agent,
  });

  const rawText = result.text;
  // Sanitize orphan tags as a safety net, then slice from the strict
  // '# Review — <title-or-ref>' heading if one is present. If no
  // strict heading exists, return the sanitized raw text so the caller
  // can validate and report a structural failure rather than silently
  // fabricating a review.
  const sanitized = sanitizeModelText(rawText);
  const extracted = extractReviewDocument(sanitized);

  // The path import keeps the bundler happy when this module is
  // imported in isolation by tests; it is also a defensive no-op in
  // production (path is only referenced for debug capture, which
  // happens inside the transport module).
  void path;

  return {
    text: extracted ?? sanitized,
    tokens: { input: result.tokens.input, output: result.tokens.output },
    cost: result.cost,
    model: result.model,
  };
}
