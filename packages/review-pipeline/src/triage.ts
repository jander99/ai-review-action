/**
 * PR-level triage: one cheap decision call that says how hard to look.
 *
 * The result only ever chooses between two depths, and every reason it
 * gives is phrased for a person reading the review header.
 */

import type { DecideRequest, DecideResult } from '@jander99/ai-review-decisions';
import type { PolicyThresholds } from '@jander99/ai-review-review-contract';
import { estimateTokens, fence } from './context';

export const TRIAGE_LIGHT_MAX_CHANGED_LINES = 200;

export type ReviewDepth = 'light' | 'detailed';

export interface TriageResult {
  readonly depth: ReviewDepth;
  readonly line: string;
  readonly reasons: ReadonlyArray<string>;
}

function cutToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return text;
  }
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
}

export function buildTriageRequest(
  input: { prTitle?: string; prBody?: string; diff: string },
  maxInputTokens: number,
): DecideRequest {
  const hasIntent = Boolean(input.prTitle || input.prBody);
  const diff = cutToTokens(input.diff, Math.max(1, maxInputTokens - 500));
  const state: Record<string, unknown> = { diff: fence('untrusted_diff', diff) };
  if (hasIntent) {
    state.intent = fence('untrusted_intent', [input.prTitle ?? '', input.prBody ?? ''].filter(Boolean).join('\n\n'));
  }
  return {
    state: JSON.stringify(state),
    questions: {
      risk: {
        type: 'choice',
        text: 'How risky is this change?',
        options: ['low', 'medium', 'high'],
      },
      ...(hasIntent
        ? { matches_intent: { type: 'noul' as const, text: 'Does the change match the stated intent?' } }
        : {}),
      touches_security: { type: 'noul', text: 'Does it touch security-sensitive code?' },
      touches_concurrency: { type: 'noul', text: 'Does it touch concurrency?' },
      touches_public_api: { type: 'noul', text: 'Does it change a public API?' },
    },
  };
}

function argmaxOf(map: Readonly<Record<string, number>>): string {
  let best = '';
  let bestScore = -Infinity;
  for (const [key, score] of Object.entries(map)) {
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

export function decideTriage(
  res: DecideResult,
  changedLines: number,
  hasIntent: boolean,
  t: PolicyThresholds,
): TriageResult {
  const a = res.answers;
  const risk = a.risk?.type === 'choice' ? a.risk.probabilities : {};
  const num = (key: string): number => {
    const answer = a[key];
    return answer?.type === 'noul' ? answer.pTrue : 1;
  };

  const riskArgmax = argmaxOf(risk);
  const riskLow = risk.low ?? 0;
  const matchesIntent = num('matches_intent');
  const security = num('touches_security');
  const concurrency = num('touches_concurrency');
  const publicApi = num('touches_public_api');
  const large = changedLines > TRIAGE_LIGHT_MAX_CHANGED_LINES;

  const light =
    riskLow >= t.keep &&
    (!hasIntent || matchesIntent >= t.keep) &&
    security <= t.drop &&
    concurrency <= t.drop &&
    publicApi <= t.drop &&
    !large;

  if (light) {
    return {
      depth: 'light',
      reasons: [],
      line: `Safe to skim: low risk, ${changedLines} changed lines, matches the stated intent.`,
    };
  }

  const reasons: string[] = [];
  if (riskArgmax !== 'low') {
    reasons.push(`${riskArgmax} risk`);
  }
  if (hasIntent && matchesIntent < t.keep) {
    reasons.push('may not match the stated intent');
  }
  const area = (score: number, name: string) => {
    if (score >= t.keep) {
      reasons.push(`touches ${name}`);
    } else if (score > t.drop) {
      reasons.push(`may touch ${name}`);
    }
  };
  area(security, 'security');
  area(concurrency, 'concurrency');
  area(publicApi, 'public API');
  if (large) {
    reasons.push(`large (${changedLines} changed lines)`);
  }

  return {
    depth: 'detailed',
    reasons,
    line: reasons.length > 0 ? `Scrutinize: ${reasons.join(', ')}.` : 'Scrutinize: triage was inconclusive.',
  };
}
