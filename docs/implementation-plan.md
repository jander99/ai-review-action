# Implementation Plan — AI Review Action

> Source of truth: `docs/design-vision.md`. This plan turns the design into
> a phased, executable build sequence with explicit ownership, scope, gates,
> and Oracle review checkpoints.
>
> Status: **Phases 1–5 complete.** All action units shipped:
> `setup-opencode` (Phase 4), `run-reviews` (Phases 1 & 2), `post-comment`
> and `post-check-run` (Phase 3), and the documentation sweep (Phase 5).

## Architecture summary

The reimagined action has three units:

1. **`setup-opencode`** (composite step) — installs OpenCode with a pinned
   version and checksum. Usable standalone, not coupled to the main action.
2. **`run-reviews`** (TypeScript) — does the heavy lifting:
   - Pre-run cleanup (deletes on-disk `opencode.json`)
   - Builds the merged `opencode.json` (action-owned agent definition,
     permission defaults, built-in provider entries, user-merged config)
   - Composes the task prompt from `file:` / `text:` inputs
   - Manages HOME isolation and `$RUNNER_TEMP` for the merged config
   - Cross-product `models × prompts`, calls `opencode run` per pair
   - Optional fusion pass with the D2 contract (labels, sanitization,
     no tools, cost included)
   - Aggregates cost/tokens; orders results stable-lexically
   - Posts partial results on failure
3. **`post-comment`** / **`post-check-run`** (TypeScript) — publishes the
   review. Event-based routing: `pull_request` → PR comment, other events
   → check run.

During planning, the prototype lived in `packages/run-reviews/src/main.ts`
(Copilot CLI shim) and `packages/post-comment/src/main.ts`. The shipped
implementation replaces the run-reviews internals with the OpenCode-based
shell-out, adds `setup-opencode` and `post-check-run` as new units, and
keeps `post-comment` (extended with the `post-comment: false` opt-out
and the existing `max-comment-chars` truncation).

## Phased plan

Five phases. Each has a clear delivery boundary and a single Oracle review
gate at the end before moving on.

### Phase 1 — Foundation

- **Scope**: Replace Copilot CLI shim in `run-reviews` with OpenCode shell-out.
  Implement the config builder (A1 on-disk cleanup, B1 temp + rebase +
  HOME isolation, B2 built-in provider registry), agent definition
  generation (C1), prompt composition (file/text, build prompt step),
  per-tool permission defaults (A3), env-var auth passthrough (6.2),
  outputs (review, cost, cost-by-model, tokens, tokens-by-model,
  models-used). Single-model, single-prompt flow. Fixture: a sample
  PR-style review runs end-to-end with Anthropic.
- **Specialist**: fixer (implementation-only); orchestrator writes the
  task spec and reviews the diff.
- **Gate**: phase-complete → @oracle review → remediation (if material) →
  user approval.
- **Oracle review**: 1
- **Reason**: critical path. Everything else builds on this. The biggest
  surface area (config builder, agent definition, prompt composition) and
  the highest cost of getting it wrong (silent misconfig, model bypass,
  env-key exposure). This is where the security boundary crystallizes.

### Phase 2 — Orchestration

- **Scope**: Multi-model loop, multi-prompt loop, stable lexical ordering
  (D8), fusion contract (D2 — labels, 50k/review size limit, sanitized
  input, no tools, cost included), partial results (D3), `fail-on-error`
  semantics.
- **Specialist**: fixer
- **Gate**: phase-complete → @oracle review → remediation → user approval.
- **Oracle review**: 1
- **Reason**: orchestration logic is the core value proposition but is
  complex (cross-product loops, fusion prompt contract, partial-results
  rules). Bugs here surface as wrong attribution, lost work, or
  confusing outputs in PR comments. Oracle review catches the edge cases
  (e.g., how does fusion handle zero successful results?).

### Phase 3 — Publishing

- **Scope**: Event-based routing (D1) — `pull_request` → `post-comment`,
  push/workflow_dispatch → `post-check-run`. New `post-check-run` step
  (TypeScript) using the GitHub Checks API. Extend existing
  `post-comment` to handle `post: false` opt-out and the existing
  max-comment-chars truncation. Outputs: `comment-url` /
  `check-run-url`.
- **Specialist**: fixer
- **Gate**: phase-complete → @oracle review → remediation → user approval.
- **Oracle review**: 1
- **Reason**: token scope and posting permissions are the security
  boundary that the rest of the action takes for granted. Getting this
  wrong means the action fails on real PRs or silently no-ops in
  non-PR contexts. Oracle reviews for alignment with GitHub Actions
  permissions model and the vision doc's event-resolution claims.

### Phase 4 — Supply chain

- **Scope**: Composite step `setup-opencode` (D4) with pinned version +
  SHA-256 checksum verification. Debug artifact capture with redaction
  (A5) — `sk-ant-*`, `sk-*`, `ghp_*`, `Bearer ...`, gzipped,
  uploaded via `actions/upload-artifact`. OpenCode version assertion
  in `run-reviews`.
- **Specialist**: fixer
- **Gate**: phase-complete → @oracle review → remediation → user approval.
- **Oracle review**: 1
- **Reason**: supply-chain vulnerability is the most damaging failure mode
  for a GitHub Action — a tampered `opencode` binary runs with full
  access to the runner. Checksum verification and version assertion are
  the primary defenses. Debug redaction is the only place secrets
  touch disk; getting it wrong leaks API keys. Both warrant Oracle review.

### Phase 5 — Documentation

- **Scope**: Rewrite `README.md` to match the vision. Update example
  workflows in `examples/` (or similar). Add a `CONTRIBUTING.md` with
  the testing guide. Capture the contract tests (D12) as a documented
  fixture suite.
- **Specialist**: fixer (no @designer — README is technical, not visual)
- **Gate**: phase-complete → @oracle review → remediation → user approval.
- **Oracle review**: 1
- **Reason**: docs are the user-facing surface. Wrong examples or
  stale inputs cause copy-paste failures. Oracle review verifies that
  every documented input, output, and sample workflow actually matches
  the implementation.

**Total Oracle reviews: 5**

## Parallelization

- **Phase 1** is the critical path. Nothing else starts until it lands.
- **Phases 2, 3, 4** can run in parallel after Phase 1, each on its own
  branch, each with its own Oracle review gate. The merged config
  builder and per-tool permission defaults from Phase 1 are the contract
  they all consume.
- **Phase 5** can begin once Phase 1 is stable — the README reflects the
  basics even before multi-model or fusion lands.

```
Phase 1 ─┬─ Phase 2 ─┐
         ├─ Phase 3 ─┼─ Phase 5 (docs evolve with each phase)
         └─ Phase 4 ─┘
```

## Risk register

| Risk | Mitigation | Phase |
|---|---|---|
| OpenCode CLI behavior changes between versions | Pin version (`opencode-version` input), version assertion at action start, D12 contract tests | 1, 4 |
| env-key exfiltration via `bash: allow` | On-disk `opencode.json` cleanup (A1), agent definition (C1), read-only permissions (A3) | 1 |
| Self-hosted runner global config overrides merged config | HOME isolation + `$RUNNER_TEMP` config (B1) | 1 |
| Config path breakage after `$RUNNER_TEMP` move | Path rebasing to source dir (B1) | 1 |
| Fork PR with no secrets → auth failures | Open design discussion; current draft skips silently | TBD (12.5) |
| Multi-model cost amplification | Fusion contract caps size (D2); `cost` output exposed for monitoring | 2 |
| Check-run API rate limits on busy repos | Retry policy in `post-check-run` | 3 |
| Tampered opencode binary | SHA-256 checksum verification in `setup-opencode` (D4) | 4 |
| Secret leakage in debug artifacts | Pattern-based redaction (A5); opt-in only | 4 |

## Open considerations

- **Branch name on implementation start**: `docs/v2-vision` is a docs
  branch. Implementation should move to a new branch
  (`feat/reimagined-v1` or similar). The current branch stays for the
  design docs; the implementation branch cherry-picks or has its own
  history.
- **Examples directory**: vision doc references `examples/` in Phase 5
  but the current repo has `.github/workflows/ai-review.yml` (the
  self-review workflow pinned to a specific commit SHA on `main`).
  Phase 5 consolidates with the new shape; prompt and config samples
  now live under `examples/prompts/` and `examples/opencode.json`.
- **Contract tests (D12)**: tracked under Phase 5 documentation as
  follow-up, but the test fixtures themselves need to be authored
  alongside the OpenCode CLI contract they verify. Treat as Phase 1
  artifacts that Phase 5 documents.

## Phase 0 — Deepwork setup (complete)

- `.gitignore` updated to include `.slim/deepwork/`
- `.ignore` created with `!.slim/deepwork/` and `!.slim/deepwork/**`
- `.slim/deepwork/progress.md` created
- This plan drafted at `docs/implementation-plan.md`
- Todos synced via `todowrite`

## Next step

All planned phases shipped. Remaining work tracked as ad-hoc follow-ups
and contract fixtures (D12); future revisions of this document are not
expected unless the action's surface area changes materially.
