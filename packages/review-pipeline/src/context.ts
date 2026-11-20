/**
 * Context assembly for the proposer.
 *
 * The diff is the review's subject and the context files are supporting
 * material, so files are dropped first. Everything is fenced as untrusted
 * input, and every omission is recorded as a note rather than silently
 * shrinking the prompt.
 */


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
  // Split on the raw `diff --git` headers: renames, quoted paths and git's
  // byte-order file order all stay correct because no path is re-derived.
  if (diff.trim() === '') {
    return [];
  }
  return diff.split(/^(?=diff --git )/m).filter((section) => section.trim() !== '');
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
