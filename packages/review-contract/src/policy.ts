/**
 * Decision policy: deterministic thresholding of decision-API judgements.
 *
 * The judge returns probabilities; this module turns them into verdicts and
 * contract severities. Pure and dependency-free so every consumer agrees.
 */

export const JUDGE_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type JudgeSeverity = typeof JUDGE_SEVERITIES[number];

import type { Severity } from './index';

export interface PolicyThresholds {
  readonly keep: number;
  readonly drop: number;
  readonly severity: number;
}

export const DEFAULT_THRESHOLDS: PolicyThresholds = { keep: 0.7, drop: 0.3, severity: 0.5 };

function checkThreshold(name: string, value: number): void {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error(`${name}-threshold must be between 0 and 1 (received ${value})`);
  }
}

export function validateThresholds(t: PolicyThresholds): void {
  checkThreshold('keep', t.keep);
  checkThreshold('drop', t.drop);
  checkThreshold('severity', t.severity);
  if (t.drop >= t.keep) {
    throw new Error(`drop-threshold must be less than keep-threshold (received keep=${t.keep}, drop=${t.drop})`);
  }
}

export interface FindingJudgement {
  readonly pSupported: number;
  readonly severity: Readonly<Record<JudgeSeverity, number>>;
  readonly duplicate: { readonly id: string; readonly p: number } | null;
}

export type PolicyVerdict = 'keep' | 'drop' | 'uncertain' | 'duplicate';

export interface PolicyOutcome {
  readonly verdict: PolicyVerdict;
  readonly severity: JudgeSeverity;
  readonly duplicateOf: string | null;
}

/**
 * Argmax severity, but a winner below `threshold` degrades one level
 * (blocker→major→minor→nit, nit stays nit). Ties go to the less severe level.
 */
export function resolveSeverity(p: Readonly<Record<JudgeSeverity, number>>, threshold: number): JudgeSeverity {
  let winner: JudgeSeverity = JUDGE_SEVERITIES[0];
  let best = -Infinity;
  // Iterate least→most severe so that on a tie the less severe level wins.
  for (let i = JUDGE_SEVERITIES.length - 1; i >= 0; i--) {
    const level = JUDGE_SEVERITIES[i];
    const value = p[level] ?? 0;
    if (value > best) {
      best = value;
      winner = level;
    }
  }
  if (best >= threshold) return winner;
  const idx = JUDGE_SEVERITIES.indexOf(winner);
  return JUDGE_SEVERITIES[Math.min(idx + 1, JUDGE_SEVERITIES.length - 1)];
}

/**
 * Rules, in order: drop at <= drop; duplicate at >= keep; keep at >= keep;
 * otherwise uncertain.
 */
export function applyPolicy(j: FindingJudgement, t: PolicyThresholds): PolicyOutcome {
  const severity = resolveSeverity(j.severity, t.severity);
  if (j.pSupported <= t.drop) return { verdict: 'drop', severity, duplicateOf: null };
  if (j.duplicate && j.duplicate.p >= t.keep) {
    return { verdict: 'duplicate', severity, duplicateOf: j.duplicate.id };
  }
  if (j.pSupported >= t.keep) return { verdict: 'keep', severity, duplicateOf: null };
  return { verdict: 'uncertain', severity, duplicateOf: null };
}

/** Judge severities mapped onto the review contract's three levels. */
export const JUDGE_TO_CONTRACT_SEVERITY: Readonly<Record<JudgeSeverity, Severity>> = {
  blocker: 'Critical',
  major: 'Warning',
  minor: 'Suggestion',
  nit: 'Suggestion',
};
