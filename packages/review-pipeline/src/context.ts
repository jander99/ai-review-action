/**
 * Context assembly for the proposer.
 *
 * The diff is the review's subject and the context files are supporting
 * material, so files are dropped first. Everything is fenced as untrusted
 * input, and every omission is recorded as a note rather than silently
 * shrinking the prompt.
 */

import { parseUnifiedDiff } from '@jander99/ai-review-review-contract';

export const CONTEXT_MAX_BYTES = 300_000;
export const PROMPT_RESERVE_TOKENS = 8_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Wrap content in a tag, neutralizing any closing tag the content contains. */
export function fence(tag: string, content: string): string {
  const neutralized = content.split(`</${tag}>`).join(`<\\/${tag}>`);
  return `<${tag}>\n${neutralized}\n</${tag}>`;
}

export interface ContextFile {
  readonly path: string;
  readonly text: string;
}

export interface ReviewContext {
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly files: ReadonlyArray<ContextFile>;
  readonly notes: ReadonlyArray<string>;
}

function splitDiffSections(diff: string): string[] {
  // parseUnifiedDiff knows what a section is; reuse it to find boundaries.
  const files = parseUnifiedDiff(diff);
  if (files.length === 0) {
    return diff.trim() === '' ? [] : [diff];
  }
  const sections: string[] = [];
  let rest = diff;
  for (const file of files) {
    const marker = `diff --git a/${file.path} b/${file.path}`;
    const idx = rest.indexOf(marker);
    if (idx === -1) {
      continue;
    }
    const next = files[files.indexOf(file) + 1];
    const end = next ? rest.indexOf(`diff --git a/${next.path} b/${next.path}`, idx + marker.length) : rest.length;
    sections.push(rest.slice(idx, end === -1 ? rest.length : end));
    rest = rest.slice(0, idx) + rest.slice(end === -1 ? rest.length : end);
  }
  return sections;
}

export function buildReviewContext(
  input: { diff: string; diffTruncated: boolean; files: ReadonlyArray<ContextFile> },
  budgetTokens: number,
): ReviewContext {
  const notes: string[] = [];

  let files = [...input.files].sort((a, b) => a.path.localeCompare(b.path)).filter((file) => {
    if (file.text.length > CONTEXT_MAX_BYTES) {
      notes.push(`context omitted: ${file.path}`);
      return false;
    }
    return true;
  });

  let sections = splitDiffSections(input.diff);
  let diffTruncated = input.diffTruncated;

  const size = () => estimateTokens(sections.join('')) + files.reduce((sum, f) => sum + estimateTokens(f.text), 0);

  while (files.length > 0 && size() + PROMPT_RESERVE_TOKENS > budgetTokens) {
    const dropped = files.pop()!;
    notes.push(`context omitted: ${dropped.path}`);
  }
  while (sections.length > 1 && size() + PROMPT_RESERVE_TOKENS > budgetTokens) {
    const dropped = sections[sections.length - 1];
    const path = dropped.match(/^diff --git a\/(.+?) b\//)?.[1] ?? '';
    sections = sections.slice(0, -1);
    diffTruncated = true;
    notes.push(`diff section omitted: ${path}`);
  }

  return { diff: sections.join(''), diffTruncated, files, notes };
}
