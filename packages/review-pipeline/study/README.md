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

Optional: `DECISION_BASE_URL` (for SubQ, `https://api.subq.ai`), `--runs` (default
20), `--out` (default: print the report).

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
