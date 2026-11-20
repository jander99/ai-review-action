/**
 * Summarizes a repeat-stability study: how often the judge flips a finding
 * between keep and drop, and how often it lands in the uncertain band.
 *
 * Pure on purpose — the study CLI that produces the runs is kept out of the
 * normal test bundle, but this folds a run list into a report.
 */

import type { PolicyVerdict } from '@jander99/ai-review-review-contract';

export interface StudyRun {
  readonly fixture: string;
  readonly findingId: string;
  readonly pSupported: number;
  readonly verdict: PolicyVerdict;
}

export interface StudyFindingStats {
  fixture: string;
  findingId: string;
  expected: 'supported' | 'unsupported' | 'borderline';
  pSupported: { mean: number; sd: number; min: number; max: number };
  verdicts: Record<PolicyVerdict, number>;
  keepDropFlip: boolean;
}

export interface StudyReport {
  runsPerFinding: number;
  findings: StudyFindingStats[];
  keepDropFlipRate: number;
  uncertainRate: number;
}

function emptyVerdicts(): Record<PolicyVerdict, number> {
  return { keep: 0, drop: 0, uncertain: 0, duplicate: 0 };
}

export function summarizeRuns(
  runs: ReadonlyArray<StudyRun>,
  expected: Readonly<Record<string, StudyFindingStats['expected']>>,
): StudyReport {
  const grouped = new Map<string, StudyRun[]>();
  for (const run of runs) {
    const key = `${run.fixture}/${run.findingId}`;
    const list = grouped.get(key);
    if (list) list.push(run);
    else grouped.set(key, [run]);
  }

  const findings: StudyFindingStats[] = [];
  let flipped = 0;
  let uncertain = 0;

  for (const [key, list] of grouped) {
    const values = list.map((r) => r.pSupported);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const verdicts = emptyVerdicts();
    for (const r of list) verdicts[r.verdict] += 1;
    const keepDropFlip = verdicts.keep > 0 && verdicts.drop > 0;
    if (keepDropFlip) flipped += 1;
    uncertain += verdicts.uncertain;
    findings.push({
      fixture: list[0].fixture,
      findingId: list[0].findingId,
      expected: expected[key] ?? 'borderline',
      pSupported: { mean, sd: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) },
      verdicts,
      keepDropFlip,
    });
  }

  return {
    runsPerFinding: findings.length > 0 ? Math.round(runs.length / findings.length) : 0,
    findings,
    keepDropFlipRate: findings.length > 0 ? flipped / findings.length : 0,
    uncertainRate: runs.length > 0 ? uncertain / runs.length : 0,
  };
}
