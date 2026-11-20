/**
 * Repeat-stability study CLI (not run in CI).
 *
 * Judges hand-written findings from ten squash commits on `main` N times
 * each through a small worker pool and writes a StudyReport JSON.
 *
 *   DECISION_PROVIDER=systemone DECISION_API_KEY=... DECISION_MODEL=... \
 *     node dist-test/study.cjs --runs 20 --out study-report.json
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDecisionClient, type DecisionClient } from '@jander99/ai-review-decisions';
import { applyPolicy, DEFAULT_THRESHOLDS, type ProposedFinding } from '@jander99/ai-review-review-contract';
import { judgeFinding } from '../src/judge';
import { summarizeRuns, type StudyRun, type StudyFindingStats } from '../src/study-summarize';

interface Fixture {
  sha: string;
  diff: string;
  files: Record<string, string>;
  findings: Array<ProposedFinding & { expected: StudyFindingStats['expected'] }>;
}

const POOL = 3;

function parseArgs(argv: ReadonlyArray<string>): { runs: number; out: string | null } {
  let runs = 20;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') runs = Number(argv[++i]);
    else if (argv[i] === '--out') out = argv[++i];
  }
  return { runs, out };
}

function loadFixtures(dir: string): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture);
}

async function withPool<T>(items: ReadonlyArray<T>, size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const { runs, out } = parseArgs(process.argv.slice(2));
  const client: DecisionClient = createDecisionClient(process.env.DECISION_PROVIDER ?? '', {
    apiKey: process.env.DECISION_API_KEY ?? '',
    model: process.env.DECISION_MODEL ?? '',
    baseUrl: process.env.DECISION_BASE_URL,
  });

  const fixtures = loadFixtures(join(__dirname, '..', 'study', 'fixtures'));
  const jobs: Array<{ fixture: Fixture; finding: Fixture['findings'][number] }> = [];
  for (const fixture of fixtures) for (const finding of fixture.findings) jobs.push({ fixture, finding });

  const results: StudyRun[] = [];
  const expected: Record<string, StudyFindingStats['expected']> = {};
  for (const { fixture, finding } of jobs) expected[`${fixture.sha}/${finding.id}`] = finding.expected;

  await withPool(jobs, POOL, async ({ fixture, finding }) => {
    const context = fixture.files[finding.file] ?? '';
    for (let i = 0; i < runs; i++) {
      const { judgement } = await judgeFinding(client, {
        finding,
        hunks: fixture.diff,
        context,
        priorFindings: [],
      });
      const outcome = applyPolicy(judgement, DEFAULT_THRESHOLDS);
      results.push({ fixture: fixture.sha, findingId: finding.id, pSupported: judgement.pSupported, verdict: outcome.verdict });
    }
  });

  const report = summarizeRuns(results, expected);
  const json = JSON.stringify(report, null, 2);
  if (out) writeFileSync(out, json + '\n');
  else console.log(json);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
