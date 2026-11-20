/**
 * Diagnostics for model documents rejected by the contract validator.
 *
 * Kept as its own module (not in the pipeline) so the orchestration layer can
 * log a bounded, line-bounded preview without depending on any runtime.
 */

/** Cap on the number of rejected-document previews surfaced per run. */
export const REJECTED_DOCUMENT_CAP = 3;

/** Default cap on the size of each preview. */
export const REJECTED_DOCUMENT_PREVIEW_MAX_CHARS = 1024;

export interface RejectedDocument {
  readonly model: string;
  readonly reason: string;
  readonly preview: string;
}

/**
 * Line-bounded preview of a document. Always <= `maxChars`: returns the input
 * verbatim when it fits, otherwise breaks at the last newline that fits, and
 * hard-truncates when no newline fits.
 */
export function buildRejectedDocumentPreview(
  text: string,
  maxChars: number = REJECTED_DOCUMENT_PREVIEW_MAX_CHARS,
): string {
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline > 0) {
    return slice.slice(0, lastNewline);
  }
  return slice;
}
