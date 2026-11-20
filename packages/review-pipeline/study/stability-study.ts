/**
 * Repeat-stability study CLI (not run in CI).
 *
 * Judges hand-written findings from ten squash commits on `main` N times
 * each through a small worker pool and writes a StudyReport JSON.
 *
 *   DECISION_PROVIDER=systemone DECISION_API_KEY=... DECISION_MODEL=... \
 *     node dist-test/study.cjs --runs 20 --out study-report.json
 *
 * `--e2e` also runs the full pipeline `--runs` times per fixture (needs
 * LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, optional LLM_BASE_URL) and reports
 * finding-set overlap next to the judge report.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDecisionClient, type DecisionClient } from '@jander99/ai-review-decisions';
import { applyPolicy, DEFAULT_THRESHOLDS, type ProposedFinding } from '@jander99/ai-review-review-contract';
import { judgeFinding } from '../src/judge';
import { createLlmClient } from '@jander99/ai-review-llm-clients';
import { runReviewPipeline } from '../src/pipeline';
import { pairwiseOverlap, summarizeRuns, type StudyRun, type StudyFindingStats } from '../src/study-summarize';

interface Fixture {
  sha: string;
  diff: string;
  files: Record<string, string>;
  findings: Array<ProposedFinding & { expected: StudyFindingStats['expected'] }>;
}

const POOL = 3;

function parseArgs(argv: ReadonlyArray<string>): { runs: number; out: string | null; e2e: boolean } {
  let runs = 20;
  let out: string | null = null;
  let e2e = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') runs = Number(argv[++i]);
    else if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--e2e') e2e = true;
  }
  return { runs, out, e2e };
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

interface EndToEndResult {
  fixture: string;
  overlap: number;
  keptCounts: number[];
}

async function runEndToEnd(decisions: DecisionClient, fixtures: ReadonlyArray<Fixture>, runs: number): Promise<EndToEndResult[]> {
  const llm = createLlmClient(process.env.LLM_PROVIDER ?? '', {
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? '',
    baseUrl: process.env.LLM_BASE_URL,
  });
  const out: EndToEndResult[] = [];
  for (const fixture of fixtures) {
    const kept: Array<Array<{ file: string; startLine: number; endLine: number }>> = [];
    for (let i = 0; i < runs; i++) {
      const result = await runReviewPipeline(
        {
          title: fixture.sha,
          diff: fixture.diff,
          diffTruncated: false,
          files: Object.entries(fixture.files).map(([path, text]) => ({ path, text })),
          repoInstructions: [],
          taskPrompt: 'Review this change for correctness bugs.',
          priorFindings: [],
        },
        { llm, decisions, thresholds: DEFAULT_THRESHOLDS, log: () => {} },
      );
      if (result.status === 'failed') throw new Error(`e2e run failed on ${fixture.sha}: ${result.failureReason}`);
      kept.push(result.kept.map((p) => p.finding));
    }
    out.push({ fixture: fixture.sha, overlap: pairwiseOverlap(kept), keptCounts: kept.map((k) => k.length) });
  }
  return out;
}

async function main(): Promise<void> {
  const { runs, out, e2e } = parseArgs(process.argv.slice(2));
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
  const endToEnd = e2e ? await runEndToEnd(client, fixtures, runs) : undefined;
  const json = JSON.stringify(endToEnd ? { ...report, endToEnd } : report, null, 2);
  if (out) writeFileSync(out, json + '\n');
  else console.log(json);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
