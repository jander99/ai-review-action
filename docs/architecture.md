# Architecture

AI Review Action is an Nx monorepo with one root JavaScript action and six standalone sub-actions. Each sub-action ships as a `packages/*/dist/main.cjs` bundle that the GitHub Actions runner executes directly.

## Layout

```text
.
├── packages/
│   ├── review-contract/      shared TypeScript helpers (sanitization, validation, prompts)
│   ├── previous-reviews/     fetch & sanitize prior bot-authored review comments
│   ├── run-reviews/          review + fusion pipeline; writes the canonical review
│   ├── validate-review/      structural + model-based validator
│   ├── setup-opencode/       install pinned OpenCode after SHA-256 verification
│   ├── post-comment/         publish a PR comment from a review document
│   ├── post-check-run/       publish a check run from a review document
│   ├── post-error-comment/   publish a short error comment when validation fails
│   └── root-action/          single JS bundle that wires the others together
├── packages/root-action/dist/main.cjs   JS bundle used as a library by the root
├── dist/main.cjs               repo-root JS bundle, the entrypoint consumers see as
│                               `owner/repo@v1`
├── action.yml                  repo-root metadata; declares main: dist/main.cjs
└── .github/workflows/          ci, ai-review (self-review), smoke, release
```

## Pipeline

The root action drives the pipeline in this order:

1. `run-reviews` invokes OpenCode for the stable lexical cross-product of prompts and models. It writes the canonical review markdown to a runner-local file under `RUNNER_TEMP`. It also emits a sanitized validator-only `config-json` that does NOT include the reviewer prompt, the runner-local path, or any literal user secret.
2. `validate-review` reads the file written by `run-reviews`, runs the deterministic structural check, then (if structural validation passed) calls OpenCode with the sanitized `config-json` for a model-based VALID/INVALID verdict.
3. The root action aggregates reviewer + validator cost into `total-cost`.
4. On a valid review, the root action publishes:
   - `post-comment` for `pull_request` events,
   - `post-check-run` for non-PR events.
5. On a failed validation (or a review that produced no document), the root action publishes:
   - `post-error-comment` for `pull_request` events,
   - `post-check-run` with `conclusion: failure` for non-PR events.

## Why a single bundle?

The previous root `action.yml` was a composite action that referenced `./packages/run-reviews` and `./packages/validate-review`. Composite `uses: ./packages/foo` paths resolve against the runner's `$GITHUB_WORKSPACE`, not the action's install location, so the action broke when invoked as `owner/repo@ref` without a workspace checkout. Converting the root to a JavaScript action with a single `dist/main.cjs` bundle removes that constraint. Each sub-action's `action.yml` is preserved so callers who want fine-grained composition can still pin a single package.

The repo-root `dist/main.cjs` is the same shape as `packages/root-action/dist/main.cjs` so consumers referencing `owner/repo@v1` get the identical pipeline. Each leaf action bundle (`packages/*/dist/main.cjs`) is built from `src/action.ts` so importing a leaf as a library never triggers its wrapper IIFE — the `if (require.main === module)` guard lives only in `action.ts`.

## Tests

There are five test files. Every package has a `node --test` target where applicable; the root-action architecture tests live in `packages/root-action/test/`. CI runs all five test files via `yarn nx run review-contract:test`, `yarn nx run previous-reviews:test`, `yarn nx run run-reviews:test`, and a manual `node --test` invocation over the root-action suite (which has its own `test` target):

- `packages/review-contract/test/contract.test.cjs` — sanitization, validation, extraction, and merging.
- `packages/previous-reviews/test/previous-reviews.test.cjs` — bot-comment filtering, truncation, fence handling, and surrogate pair safety.
- `packages/run-reviews/test/config-builder.test.cjs` — sanitized validator config and secret redaction.
- `packages/run-reviews/test/failure-reason.test.cjs` — wrapper output ordering and the bundle's single `require.main === module` guard.
- `packages/root-action/test/inputs.test.cjs` — action.yml parity, every wired API exported, requiring the bundle does not trigger leaf side effects.

## Remote invocation

Because the root action is now a single JS bundle, it works under remote invocation as `owner/repo@ref` (where the runner downloads the action directory but does not have a workspace checkout that matches `./packages/foo` references). The smoke workflow (`/.github/workflows/smoke.yml`) verifies the bundle by:
1. Reading the `main:` path from `action.yml` at runtime.
2. Copying `action.yml` and the resolved bundle to `/tmp/ai-review-smoke/`.
3. Parsing the action metadata (required inputs/outputs, `using: node24`).
4. Requiring the bundle from the scratch directory and asserting it loads and exports the wired APIs.

## Related documentation

- [README](../README.md) — quickstart, inputs, outputs, sample workflows, vetted OpenCode versions.
- [Design vision](design-vision.md) — runtime and security contracts.
- [CONTRIBUTING](../CONTRIBUTING.md) — local development and verification commands.
- [Security policy](../SECURITY.md) — threat model, supply-chain guidance, and reporting.