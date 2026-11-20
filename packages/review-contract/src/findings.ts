/**
 * Finding types shared across the pipeline, plus the stable finding identity
 * used to dedupe and to reference prior findings.
 */

import { createHash } from 'node:crypto';
import type { Severity } from './index';
import type { JudgeSeverity } from './policy';

export interface ProposedFinding {
  readonly id: string;
  readonly file: string;
  readonly relatedFiles: ReadonlyArray<string>;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly claim: string;
  readonly evidence: string;
  readonly suggestedFix: string | null;
}

export interface PriorFinding {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly title: string;
}

export interface PostableFinding {
  readonly finding: ProposedFinding;
  readonly severity: Severity;
  readonly judgeSeverity: JudgeSeverity;
  readonly pSupported: number | null;
  readonly note: string;
}

function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Stable id: `F` + the first 10 hex chars of sha256 over file and normalized title. */
export function findingId(file: string, title: string): string {
  const hash = createHash('sha256').update(`${file}\n${normalizeKey(title)}`).digest('hex');
  return `F${hash.slice(0, 10)}`;
}
