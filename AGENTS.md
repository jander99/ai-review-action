# AGENTS.md

Nx + Yarn 4 monorepo for a GitHub Action that runs AI reviews (an LLM proposes findings, a decision API judges each one, deterministic policy decides what is posted). See `docs/architecture.md` and `docs/design-vision.md` for design; `CONTRIBUTING.md` for workflow.

## Commands

```bash
corepack enable && yarn install --immutable
yarn build                                # all packages
yarn nx run repo-root:build               # repo-root dist/main.cjs
yarn nx run <pkg>:test                    # decisions, llm-clients, review-contract, review-pipeline, previous-reviews, run-reviews, post-comment
(cd packages/root-action && node --test test/*.test.cjs)
for c in packages/*/tsconfig.json; do yarn tsc --noEmit -p "$c"; done
```

## Rules

- **`dist/` is committed.** CI fails if bundles drift. After source changes run `yarn build` + `yarn nx run repo-root:build` and commit the bundles. Never regenerate or hand-edit `dist/` for docs-only changes.
- **Orchestration lives in one place.** `packages/root-action/src/orchestrate.ts` holds the shared logic; `main.ts` and `action-entry.ts` are thin entries. Pipeline logic belongs in `packages/review-pipeline`, which takes injected clients and reads no env.
- **Review format has one source of truth:** `packages/review-contract` (document parser/validator, merge, policy, finding comments, diff parsing, proposer schema). Changes must keep `contract.test.cjs` and `policy.test.cjs` passing.
- **Tests run against bundles.** Most import `dist/` or gitignored `dist-test/`. Run the package's `build-tests` (done automatically by `:test`) before running `node --test` directly.
- **Leaf `action.ts` owns `require.main === module`.** Keep `src/main.ts` / `src/index.ts` free of `@actions/core` side effects; tests assert this.
- **Adapter rules** (`packages/llm-clients`, `packages/decisions`): adapters never read `process.env`; they pass `apiKey` and `baseURL` explicitly to the SDK; error messages go through `redactSecret`; retries come only from the SDK's policy; there is no fallback from the decision API to an LLM judge. Every adapter must pass its package's `test/conformance.cjs`.
- **Library packages have no committed `dist/`.** `decisions`, `llm-clients` and `review-pipeline` only build `dist-test/` (gitignored); consumers bundle them.
- **Untrusted input:** diff, file text and PR text are fenced data in prompts; repo instructions are read from the base SHA; judge state is JSON-encoded.
- **Provider SDK bumps:** check call names against current docs and the installed `.d.ts`, pin exact versions, commit `yarn.lock`, and re-run the conformance suites. SDKs need Node 22+.
- Adding action inputs/outputs: update `action.yml`, README tables, and the lists in `root-action/test/inputs.test.cjs` and `smoke.yml`.
