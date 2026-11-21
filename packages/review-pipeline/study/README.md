# Repeat-stability study

Measures how stable the judge is when it sees the same finding many times.
It is a release gate, not a CI job — it costs real decision-API calls.

## Running it

```bash
DECISION_PROVIDER=systemone \
DECISION_API_KEY=... \
DECISION_MODEL=subq-snap-1.2 \
  yarn nx run review-pipeline:study -- --runs 20 --out study-report.json
```

`--e2e` also runs the whole pipeline `--runs` times per fixture and adds an
`endToEnd` list (`fixture`, `overlap`, `keptCounts`). It needs `LLM_PROVIDER`,
`LLM_API_KEY`, `LLM_MODEL` and optionally `LLM_BASE_URL`. `overlap` is the mean
pairwise Jaccard of the kept finding sets (1 = identical, matched by file and
overlapping line range); the proposer is still non-deterministic, so expect
it below 1.

Optional: `DECISION_BASE_URL` (for SubQ, `https://api.subq.ai`), `--runs` (default
20), `--out` (default: print the report). E2E tuning: `STUDY_POOL` (concurrency,
default 3), `STUDY_MAX_RETRIES`, `STUDY_FIXTURE` (one fixture), `STUDY_VERBOSE`,
`STUDY_REASONING_EFFORT` (`minimal|low|medium|high`, `openai` provider only).
Don't run two e2e studies at once against one key; they trip rate limits.

## Fixtures

`fixtures/<sha>.json` holds one squash commit from `main`: the diff (excluding
`dist/`), the touched files' text, and three hand-written findings tagged
`supported`, `unsupported` or `borderline`. Regenerate a diff with:

```bash
git diff <sha>~1 <sha> -- . ':(exclude)dist/**' ':(exclude)packages/*/dist*/**'
```

## Release gate

Read from `keepDropFlipRate` and `uncertainRate` in the report:

- `keepDropFlipRate` — the share of findings that got both `keep` and `drop`
  across runs. Any flip means the thresholds are too tight for the judge's
  noise; treat a non-zero rate as a signal to widen the uncertain band.
- `uncertainRate` — the share of runs that landed in the uncertain band. A high
  rate is honest but costly: it means most findings need a second look.

Cross-check each finding's `expected` tag against its `verdicts`: a
`supported` finding that mostly drops, or an `unsupported` one that mostly
keeps, is a calibration bug, not noise.

## Known-bug recall

`bug-fixtures/` holds seven real v2 bugs (fixed in PR #49) re-presented as the
change: the fix is reversed and its removed side stripped so the diff cannot leak
the answer. `bug-recall.ts` runs the full pipeline per fixture and reports
`proposedRecall` (the LLM named the bug) and `keptRecall` (it survived the
judge). Same env as the stability study; build and run:

```bash
esbuild study/bug-recall.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist-test/bug-recall.cjs
node dist-test/bug-recall.cjs --runs 5 --out bug-report.json
```

Regenerate fixtures with `node study/generate-bug-fixtures.cjs`. A hit is a
finding in the right file within 3 lines of a ground-truth range.

## Runtime metrics

Both studies record wall-clock per successful run (`meanMs`, `p50Ms`, `p95Ms`,
`maxMs`) and mean tokens per run (`llmIn`, `llmOut`, `decisionIn`); bug-recall
also records LLM calls per run. Run with `STUDY_POOL=1` for clean latency; a
larger pool adds queueing to the numbers. Runs that skip the proposer count as 0 tokens.
