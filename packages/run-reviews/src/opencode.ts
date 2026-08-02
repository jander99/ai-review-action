import { extractReviewDocument, sanitizeModelText } from '@jander99/ai-review-review-contract';
import type { ReviewResult } from './types';
import {
  runOpenCodeRun,
  type DebugCapturePaths,
} from './opencode-run';

export type { DebugCapturePaths } from './opencode-run';

export interface InvokeOpenCodeOptions {
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
 * Invoke OpenCode through the one-shot `opencode run --format=json` transport.
 * The transport owns process and stream handling; this wrapper preserves the
 * review pipeline's sanitization and canonical document extraction.
 */
export async function invokeOpenCode(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeOpenCodeOptions,
): Promise<ReviewResult> {
  const result = await runOpenCodeRun({
    configPath,
    homeDir: options.homeDir,
    model,
    prompt,
    timeoutMinutes: options.timeoutMinutes ?? 30,
    disableTools: options.disableTools,
    debugCapture: options.debugCapture,
  });

  const rawText = result.text;
  const sanitized = sanitizeModelText(rawText);
  const extracted = extractReviewDocument(sanitized);

  return {
    text: extracted ?? sanitized,
    tokens: { input: result.tokens.input, output: result.tokens.output },
    cost: result.cost,
    model: result.model,
  };
}
