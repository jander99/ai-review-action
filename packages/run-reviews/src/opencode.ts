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

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '');
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
        const cleaned = stripThinkBlocks(value);
        if (cleaned.trim()) {
          text.push(cleaned);
        }
      }
    } else if (event.part?.type === 'text' && event.part.text) {
      const cleaned = stripThinkBlocks(event.part.text);
      if (cleaned.trim()) {
        text.push(cleaned);
      }
    }

    if (event.type === 'step_finish' || event.part?.type === 'step_finish') {
      const tokens = event.tokens ?? event.part?.tokens;
      inputTokens += tokens?.input ?? 0;
      outputTokens += tokens?.output ?? 0;
      cost += event.cost ?? event.part?.cost ?? 0;
    }
  }

  return {
    text: text.join(''),
    tokens: { input: inputTokens, output: outputTokens },
    cost,
    model,
  };
}
