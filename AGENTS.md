# AGENTS.md

Nx + Yarn 4 monorepo for a GitHub Action that runs AI reviews (OpenCode or Claude Code CLI via `tool` input). See `docs/architecture.md` and `docs/design-vision.md` for design; `CONTRIBUTING.md` for workflow.

## Commands

```bash
corepack enable && yarn install --immutable
yarn build                                # all packages
yarn nx run repo-root:build               # repo-root dist/main.cjs
yarn nx run <pkg>:test                    # review-contract, previous-reviews, run-reviews, validate-review
(cd packages/root-action && node --test test/*.test.cjs)
for c in packages/*/tsconfig.json; do yarn tsc --noEmit -p "$c"; done
```

## Rules

- **`dist/` is committed.** CI fails if bundles drift. After source changes run `yarn build` + `yarn nx run repo-root:build` and commit the bundles. Never regenerate or hand-edit `dist/` for docs-only changes.
- **Orchestration is duplicated.** `packages/root-action/src/main.ts` and `action-entry.ts` are near-copies. Change both.
- **Review format has one source of truth:** `packages/review-contract/src/index.ts` (prompt templates, parser/validator, merge). Template edits must keep `contract.test.cjs` passing.
- **Tests run against bundles.** Most import `dist/` or gitignored `dist-test/`. Run the package's `build-tests` (done automatically by `:test`) before running `node --test` directly.
- **Leaf `action.ts` owns `require.main === module`.** Keep `src/main.ts` / `src/index.ts` free of `@actions/core` side effects; tests assert this.
- **Claude runtime security:** env is an allow-list (never spread `process.env`), `--allowedTools` is read-only git + Read/Glob/Grep, no `--dangerously-skip-permissions`, no `query` tool.
- **OpenCode version bump** touches many files; follow `CONTRIBUTING.md` ("Updating OpenCode").
- Adding action inputs/outputs: update `action.yml`, README tables, and the lists in `root-action/test/inputs.test.cjs` and `smoke.yml`.

## Known drift

README's Claude-runtime notes (`--dangerously-skip-permissions`, `query`, "validator is opencode-only") are stale vs. code. `release.yml` only checks two dist dirs.
