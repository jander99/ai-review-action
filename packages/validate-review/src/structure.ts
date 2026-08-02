// Deterministic structural validator for the review markdown. The model
// is used only as a secondary check; the structural rules here are the
// authoritative contract. Keep the patterns in sync with the prompt in
// `packages/run-reviews/src/agent-definition.ts`.

const HEADING_LINE_PATTERN = /^# Review\b[^]*?/;
const SUMMARY_HEADING_PATTERN = /^## Summary\b/m;
const FINDINGS_HEADING_PATTERN = /^## Findings\b/m;
const FINDING_BLOCK_PATTERN = /^### (🔴 Critical|🟡 Warning|🟢 Suggestion) —\s*(.+?)$/;
const FIELD_LINE_PATTERN = /^-\s*(Status|Location|Description):\s*(.+?)$/;
const STATUS_VALUES = new Set(['new', 'unresolved', 'resolved', 'new variant']);
const MAX_FILE_BYTES = 256_000;

export interface ValidationResult {
  valid: boolean;
  reason: string;
}

function skipFenceLines(lines: string[]): { line: string; inFence: boolean } {
  return { line: '', inFence: false };
}

function isInsideFence(lines: string[], index: number): boolean {
  let fenceOpen = false;
  for (let i = 0; i < index; i++) {
    if (lines[i].trim().startsWith('```')) {
      fenceOpen = !fenceOpen;
    }
  }
  return fenceOpen;
}

function validateSummary(content: string): string | null {
  const headingMatch = content.match(SUMMARY_HEADING_PATTERN);
  if (!headingMatch) {
    return 'missing ## Summary section';
  }
  const summaryStart = headingMatch.index ?? 0;
  const summarySlice = content.slice(summaryStart);

  const requiredFields: { label: string; pattern: RegExp }[] = [
    { label: 'New findings', pattern: /^\s*-\s*New findings:\s*\d+\s*$/m },
    { label: 'Unresolved from prior review', pattern: /^\s*-\s*Unresolved from prior review:\s*\d+\s*$/m },
    { label: 'Resolved by latest commits', pattern: /^\s*-\s*Resolved by latest commits:\s*\d+\s*$/m },
  ];

  for (const { label, pattern } of requiredFields) {
    if (!pattern.test(summarySlice)) {
      return `## Summary section is missing required field: ${label}`;
    }
  }

  return null;
}

function validateFindings(content: string): string | null {
  const lines = content.split('\n');
  let foundAny = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!FINDING_BLOCK_PATTERN.test(line)) {
      i += 1;
      continue;
    }
    if (isInsideFence(lines, i)) {
      i += 1;
      continue;
    }
    foundAny = true;

    const fields: Record<string, string> = {};
    let j = i + 1;
    while (j < lines.length && !FINDING_BLOCK_PATTERN.test(lines[j])) {
      const fieldMatch = lines[j].match(FIELD_LINE_PATTERN);
      if (fieldMatch) {
        fields[fieldMatch[1].toLowerCase()] = fieldMatch[2];
      }
      j += 1;
    }

    if (!fields.status) {
      return `finding at line ${i + 1} is missing Status field`;
    }
    if (!STATUS_VALUES.has(fields.status.toLowerCase())) {
      return `finding at line ${i + 1} has invalid Status value: ${fields.status}`;
    }
    if (!fields.location) {
      return `finding at line ${i + 1} is missing Location field`;
    }
    if (!fields.description) {
      return `finding at line ${i + 1} is missing Description field`;
    }

    i = j;
  }

  if (!foundAny) {
    return 'no findings blocks were found';
  }

  return null;
}

export function validateReviewStructure(content: string): ValidationResult {
  if (content.length > MAX_FILE_BYTES) {
    return { valid: false, reason: `review file exceeds ${MAX_FILE_BYTES} bytes` };
  }

  if (!HEADING_LINE_PATTERN.test(content)) {
    return { valid: false, reason: 'missing # Review heading at the top of the file' };
  }

  // Strip orphan tags before structural checks so the model can still emit
  // thinking blocks without invalidating the structure.
  const cleaned = content.replace(/<\/?(?:think|tool_call|tool_result|mm:think|script)>|<!--|-->/gi, '');

  // Ensure the heading appears before the summary and findings sections.
  const headingMatch = cleaned.match(HEADING_LINE_PATTERN);
  if (!headingMatch || (headingMatch.index ?? 0) > 0) {
    return { valid: false, reason: 'review must start with the # Review heading' };
  }

  if (!SUMMARY_HEADING_PATTERN.test(cleaned)) {
    return { valid: false, reason: 'missing ## Summary section' };
  }
  if (!FINDINGS_HEADING_PATTERN.test(cleaned)) {
    return { valid: false, reason: 'missing ## Findings section' };
  }

  const summaryError = validateSummary(cleaned);
  if (summaryError) return { valid: false, reason: summaryError };

  const findingsError = validateFindings(cleaned);
  if (findingsError) return { valid: false, reason: findingsError };

  return { valid: true, reason: '' };
}
