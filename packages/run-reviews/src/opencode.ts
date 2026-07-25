import { spawnSync } from 'child_process';
import * as fs from 'fs';
import type { ReviewResult } from './types';

export interface InvokeOpenCodeOptions {
  homeDir: string;
  timeoutMinutes?: number;
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

  const result = spawnSync('opencode', args, {
    env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: (options.timeoutMinutes ?? 30) * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`opencode exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }

  const text: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;

  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
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
    text: text.join(''),
    tokens: { input: inputTokens, output: outputTokens },
    cost,
    model,
  };
}
