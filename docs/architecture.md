# Architecture

AI Review Action is an Nx monorepo with one root JavaScript action and a few standalone sub-actions. Action bundles ship as committed `dist/main.cjs` files that the runner executes directly. Library packages (`decisions`, `llm-clients`, `review-pipeline`) have no committed bundle; consumers bundle them.

## Layout

```text
.
├── packages/
│   ├── review-contract/      review format, parser/validator, merge, policy, diff parsing, finding comments
│   ├── decisions/            DecisionClient, registry, adapters: systemone (TypeSafe, SubQ), google
│   ├── llm-clients/          LlmClient, registry, adapters: openai, anthropic, gemini
│   ├── review-pipeline/      runReviewPipeline: context, triage, propose, judge, render; stability study
│   ├── previous-reviews/     fetch prior bot findings (issue comments, review comments, reviews)
│   ├── run-reviews/          IO: event context, filtered diff, base-branch instructions, calls the pipeline
│   ├── post-comment/         postReview: batched inline PR review
│   ├── post-check-run/       publish a check run from a review document
│   ├── post-error-comment/   publish a short error comment when the review fails
│   └── root-action/          shared orchestration (orchestrate.ts) and the entry points
├── dist/main.cjs             repo-root bundle, the entrypoint consumers see as `owner/repo@v2`
├── action.yml                repo-root metadata; declares main: dist/main.cjs
└── .github/workflows/        ci, ai-review (self-review), smoke, release
```

## Pipeline

The root action drives these steps (details in the [design vision](design-vision.md)):

1. `run-reviews` builds the pipeline input: filtered diff, changed files' text, base-branch repo instructions, and prior findings from `previous-reviews`.
2. `runReviewPipeline` triages the PR (decision API), proposes findings (LLM, schema-checked JSON), judges each finding (decision API, 3 at a time), applies the policy in `review-contract`, and renders the canonical review document.
3. On `ok`, a PR event goes to `postReview` (batched inline review, unanchorable findings in the body); other events go to `post-check-run`.
4. On `no_findings_produced` the review is published with a warning and a neutral check conclusion. On `failed`, `post-error-comment` (PR) or a failing check run (other events) is published and the action fails.

Pipeline code takes injected `LlmClient` and `DecisionClient` instances and never imports a vendor SDK, reads env, or touches `@actions/core`.

## Why a single bundle?

The previous root `action.yml` was a composite action that referenced `./packages/run-reviews` and `./packages/validate-review`. Composite `uses: ./packages/foo` paths resolve against the runner's `$GITHUB_WORKSPACE`, not the action's install location, so the action broke when invoked as `owner/repo@ref` without a workspace checkout. Converting the root to a JavaScript action with a single `dist/main.cjs` bundle removes that constraint. Each sub-action's `action.yml` is preserved so callers who want fine-grained composition can still pin a single package.

The repo-root `dist/main.cjs` is the same shape as `packages/root-action/dist/main.cjs` so consumers referencing `owner/repo@v2` get the identical pipeline. Each leaf action bundle (`packages/*/dist/main.cjs`) is built from `src/action.ts` so importing a leaf as a library never triggers its wrapper IIFE — the `if (require.main === module)` guard lives only in `action.ts`.

## Tests

Tests run against bundles: `dist/` for committed bundles, gitignored `dist-test/` for library packages. `yarn nx run <pkg>:test` builds first. CI runs `yarn nx run-many --target=test` plus the root-action suite (`cd packages/root-action && node --test test/*.test.cjs`).

- Adapter packages share a `test/conformance.cjs` suite (schema-valid output, error mapping, retry, no secret in errors, timeouts, env isolation) run against recorded fixtures.
- `review-contract` covers the document format, policy thresholds, diff parsing and finding comments.
- `review-pipeline` covers context building, triage, proposing, judging, rendering and the pipeline end to end with fake clients.
- `root-action` covers `action.yml` parity (inputs and outputs, no removed v1 names), bundle exports, and orchestration.

## Remote invocation

Because the root action is now a single JS bundle, it works under remote invocation as `owner/repo@ref` (where the runner downloads the action directory but does not have a workspace checkout that matches `./packages/foo` references). The smoke workflow (`/.github/workflows/smoke.yml`) verifies the bundle by:
1. Reading the `main:` path from `action.yml` at runtime.
2. Copying `action.yml` and the resolved bundle to `/tmp/ai-review-smoke/`.
3. Parsing the action metadata (required inputs/outputs, `using: node24`).
4. Requiring the bundle from the scratch directory and asserting it loads and exports the wired APIs.

## Related documentation

- [README](../README.md) — quickstart, inputs, outputs, sample workflows, provider matrix.
- [Design vision](design-vision.md) — runtime and security contracts.
- [CONTRIBUTING](../CONTRIBUTING.md) — local development and verification commands.
- [Security policy](../SECURITY.md) — threat model, supply-chain guidance, and reporting.