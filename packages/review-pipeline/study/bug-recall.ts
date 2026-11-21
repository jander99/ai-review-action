/**
 * Known-bug recall study (not run in CI). For each fixture in `bug-fixtures/`
 * (a real, since-fixed v2 bug presented as the change) it runs the full
 * pipeline N times and records whether the bug was
 *   - proposed (the LLM named it), and
 *   - kept (it survived the decision judge and policy).
 * A hit is a finding in the same file whose line range overlaps a ground-truth
 * range (+/- SLACK lines). Other kept findings are counted as `extraKept`.
 *
 *   (same env as stability-study) node dist-test/bug-recall.cjs --runs 5 --out report.json
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDecisionClient } from '@jander99/ai-review-decisions';
import { DEFAULT_THRESHOLDS } from '@jander99/ai-review-review-contract';
import { createLlmClient, type LlmClient } from '@jander99/ai-review-llm-clients';
import { runReviewPipeline } from '../src/pipeline';

const SLACK = 3;

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
function pct(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0;
}
/** Wall-clock stats in ms for one set of runs. */
function stats(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  return { runs: xs.length, meanMs: Math.round(mean(xs)), p50Ms: pct(sorted, 0.5), p95Ms: pct(sorted, 0.95), maxMs: sorted[sorted.length - 1] ?? 0 };
}
const MAX_RETRIES = Number(process.env.STUDY_MAX_RETRIES ?? 10);

interface BugFixture {
  sha: string;
  diff: string;
  files: Record<string, string>;
  bug: { file: string; description: string; ranges: Array<{ startLine: number; endLine: number }> };
}

interface Loc { file: string; startLine: number; endLine: number }

function hits(f: Loc, bug: BugFixture['bug']): boolean {
  return f.file === bug.file && bug.ranges.some((r) => f.startLine <= r.endLine + SLACK && f.endLine >= r.startLine - SLACK);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(args[args.indexOf('--runs') + 1] ?? 5) || 5;
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
  const only = process.env.STUDY_FIXTURE;
  const dir = join(__dirname, '..', 'study', 'bug-fixtures');
  const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as BugFixture)
    .filter((f) => !only || f.sha.includes(only));

  const decisions = createDecisionClient(process.env.DECISION_PROVIDER ?? '', {
    apiKey: process.env.DECISION_API_KEY ?? '',
    model: process.env.DECISION_MODEL ?? '',
    baseUrl: process.env.DECISION_BASE_URL,
    options: { maxRetries: MAX_RETRIES },
  });
  const base = createLlmClient(process.env.LLM_PROVIDER ?? '', {
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? '',
    baseUrl: process.env.LLM_BASE_URL,
    options: {
      maxRetries: MAX_RETRIES,
      ...(process.env.STUDY_REASONING_EFFORT ? { reasoningEffort: process.env.STUDY_REASONING_EFFORT } : {}),
    },
  });

  const results = [];
  const allMs: number[] = [];
  const allCalls: number[] = [];
  const studyStart = Date.now();
  for (const fx of fixtures) {
    let proposedHits = 0;
    let keptHits = 0;
    let uncertainHits = 0;
    let failed = 0;
    const extraKept: number[] = [];
    const proposedCounts: number[] = [];
    const runMs: number[] = [];
    const llmCalls: number[] = [];
    const tokens = { llmIn: 0, llmOut: 0, decisionIn: 0 };
    for (let i = 0; i < runs; i++) {
      let proposed: Loc[] = [];
      let calls = 0;
      const started = Date.now();
      const llm: LlmClient = {
        ...base,
        async complete(req) {
          calls++;
          const res = await base.complete(req);
          const list = (res.value as { findings?: Loc[] })?.findings;
          if (Array.isArray(list)) proposed = list;
          return res;
        },
      };
      try {
        const result = await runReviewPipeline(
          {
            title: fx.sha,
            diff: fx.diff,
            diffTruncated: false,
            files: Object.entries(fx.files).map(([path, text]) => ({ path, text })),
            repoInstructions: [],
            taskPrompt: 'Review this change for correctness bugs.',
            priorFindings: [],
          },
          { llm, decisions, thresholds: DEFAULT_THRESHOLDS, log: () => {} },
        );
        if (result.status === 'failed') { failed++; continue; }
        runMs.push(Date.now() - started);
        allMs.push(Date.now() - started);
        allCalls.push(calls);
        llmCalls.push(calls);
        tokens.llmIn += result.usage.llmInputTokens;
        tokens.llmOut += result.usage.llmOutputTokens;
        tokens.decisionIn += result.usage.decisionInputTokens;
        const kept = result.kept.map((p) => p.finding);
        const uncertain = result.uncertain.map((p) => p.finding);
        if (proposed.some((f) => hits(f, fx.bug))) proposedHits++;
        if (kept.some((f) => hits(f, fx.bug))) keptHits++;
        if (uncertain.some((f) => hits(f, fx.bug))) uncertainHits++;
        extraKept.push(kept.filter((f) => !hits(f, fx.bug)).length);
        proposedCounts.push(proposed.length);
        console.error(`${fx.sha} run ${i + 1}/${runs}: proposed ${proposed.length}, kept ${kept.length}, bug ${kept.some((f) => hits(f, fx.bug)) ? 'KEPT' : proposed.some((f) => hits(f, fx.bug)) ? 'proposed-only' : 'missed'}`);
      } catch (err) {
        failed++;
        console.error(`${fx.sha} run ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const done = runs - failed;
    results.push({ fixture: fx.sha, runs: done, failed, proposedRecall: done ? proposedHits / done : 0, keptRecall: done ? keptHits / done : 0, uncertainHits, extraKept, proposedCounts, runtime: { ...stats(runMs), llmCallsPerRun: mean(llmCalls), avgTokens: { llmIn: Math.round(tokens.llmIn / (done || 1)), llmOut: Math.round(tokens.llmOut / (done || 1)), decisionIn: Math.round(tokens.decisionIn / (done || 1)) } } });
  }
  const total = results.reduce((s, r) => s + r.runs, 0) || 1;
  const summary = {
    proposedRecall: results.reduce((s, r) => s + r.proposedRecall * r.runs, 0) / total,
    keptRecall: results.reduce((s, r) => s + r.keptRecall * r.runs, 0) / total,
    runtime: { ...stats(allMs), llmCallsPerRun: mean(allCalls), studyWallMs: Date.now() - studyStart },
    avgExtraKept: results.flatMap((r) => r.extraKept).reduce((s, v) => s + v, 0) / (results.flatMap((r) => r.extraKept).length || 1),
  };
  const json = JSON.stringify({ summary, results }, null, 2);
  if (out) writeFileSync(out, json + '\n'); else console.log(json);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
