import * as fs from 'fs';
import * as path from 'path';
import type { PromptEntry } from './types';

export function parsePrompts(input: string): PromptEntry[] {
  const workspace = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const entries = input
    .split(/,\s*(?=(?:file|text):)/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error('At least one prompt is required');
  }

  return entries.map((entry) => {
    if (entry.startsWith('file:')) {
      const source = entry.slice('file:'.length).trim();
      if (!source) {
        throw new Error('Prompt file path cannot be empty');
      }

      const filePath = path.isAbsolute(source) ? source : path.resolve(workspace, source);
      return {
        type: 'file' as const,
        source: filePath,
        content: fs.readFileSync(filePath, 'utf8'),
      };
    }

    if (entry.startsWith('text:')) {
      return {
        type: 'text' as const,
        source: entry.slice('text:'.length),
        content: entry.slice('text:'.length),
      };
    }

    throw new Error(`Prompt entry must start with file: or text:: ${entry}`);
  });
}

export function composeTaskPrompt(prompts: PromptEntry[]): string {
  return prompts.map((prompt) => prompt.content).join('\n\n');
}
