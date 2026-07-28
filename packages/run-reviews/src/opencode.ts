import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ReviewResult } from './types';

export interface DebugCapturePaths {
  stdoutPath: string;
  stderrPath: string;
}

export interface InvokeOpenCodeOptions {
  homeDir: string;
  timeoutMinutes?: number;
  disableTools?: boolean;
  debugCapture?: DebugCapturePaths;
}

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

// Strip model-emitted markup that must never reach the PR comment or the fusion
// synthesizer input. Keep paired and orphan patterns in sync with the
// equivalents in `fusion.ts`.
const NOISE_BLOCK_PATTERNS: ReadonlyArray<RegExp> = [
  /<think[\s\S]*?<\/think>/g,
  /<!--[\s\S]*?-->/g,
  /<tool_call>[\s\S]*?<\/tool_call>/g,
  /<tool_result>[\s\S]*?<\/tool_result>/g,
  /<mm:think[\s\S]*?<\/mm:think>/g,
];

const ORPHAN_TAG_PATTERN =
  /<\/?(?:think|tool_call|tool_result|mm:think)>|<!--|-->/g;

function stripNoiseBlocks(text: string): string {
  let result = text;
  for (const pattern of NOISE_BLOCK_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.replace(ORPHAN_TAG_PATTERN, '');
}

// Parser boundary: the prompt contract requires the review body to begin with
// `# PR #N Review — <title>`. Walks the text line by line so we can skip any
// heading that appears inside a fenced code block, then returns the heading
// line and everything after. Returns `null` if no valid heading exists outside
// a fence.
const HEADING_LINE_PATTERN = /^# PR #\d+ Review\b/;
const FENCE_LINE_PATTERN = /^```/;

function findHeadingBoundary(text: string): string | null {
  const lines = text.split('\n');
  let fenceOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_LINE_PATTERN.test(line)) {
      fenceOpen = !fenceOpen;
      continue;
    }
    if (fenceOpen) {
      continue;
    }
    if (HEADING_LINE_PATTERN.test(line)) {
      return lines.slice(i).join('\n');
    }
  }
  return null;
}

// Process the joined text from all stream events: strip noise, then slice from
// the heading boundary if present, otherwise fall back to the stripped text so
// a model that forgot the contract still publishes something usable.
function processReviewText(text: string): string {
  const stripped = stripNoiseBlocks(text);
  const boundary = findHeadingBoundary(stripped);
  if (boundary !== null) {
    return boundary;
  }
  return stripped;
}

export function invokeOpenCode(
  prompt: string,
  model: string,
  configPath: string,
  options: InvokeOpenCodeOptions,
): ReviewResult {
  fs.mkdirSync(options.homeDir, { recursive: true });
  const args = ['run', prompt, '--model', model, '--format', 'json'];
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('OPENCODE_')) {
      delete env[name];
    }
  }
  env.OPENCODE_CONFIG = configPath;
  env.HOME = options.homeDir;
  if (options.disableTools) {
    env.OPENCODE_PERMISSION = JSON.stringify({
      read: 'deny',
      glob: 'deny',
      grep: 'deny',
      list: 'deny',
      webfetch: 'deny',
      edit: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      bash: 'deny',
    });
  }

  const result = spawnSync('opencode', args, {
    env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: (options.timeoutMinutes ?? 30) * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (options.debugCapture) {
    fs.mkdirSync(path.dirname(options.debugCapture.stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(options.debugCapture.stderrPath), { recursive: true });
    fs.writeFileSync(options.debugCapture.stdoutPath, stdout, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(options.debugCapture.stderrPath, stderr, { encoding: 'utf8', mode: 0o600 });
  }

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const errorOutput = stderr.trim();
    throw new Error(`opencode exited with status ${result.status}${errorOutput ? `: ${errorOutput}` : ''}`);
  }

  const text: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line) as OpenCodeEvent;
    if (event.type === 'text') {
      const value = event.text ?? event.part?.text;
      if (value) {
        text.push(value);
      }
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
    text: processReviewText(text.join('')),
    tokens: { input: inputTokens, output: outputTokens },
    cost,
    model,
  };
}