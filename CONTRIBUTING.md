# Contributing

Thank you for improving AI Review Action. The [design vision](docs/design-vision.md) is the source of truth for architecture, security boundaries, inputs, outputs, and runtime behavior. Review the design vision before changing a contract.

## Local development

The repository is an Nx monorepo managed with Yarn 4. Source lives under `packages/*/src`. Action packages commit their bundle under `packages/*/dist`; the library packages (`decisions`, `llm-clients`, `review-pipeline`) have none and are bundled into their consumers. The root action is a single JavaScript bundle under `packages/root-action/`.

Prerequisites:

- Linux or macOS for local development.
- Node.js 22 or newer (the provider SDKs require it).
- Corepack enabled.

Install, build, and type-check every package:

```bash
corepack enable
yarn install --immutable
yarn build
for config in packages/*/tsconfig.json; do yarn tsc --noEmit -p "$config"; done
```

`yarn install` is also suitable while intentionally changing dependencies; commit the resulting `yarn.lock`. Use `yarn install --immutable` for CI-equivalent verification.

The built `dist/main.cjs` files are committed because consumers execute them directly. After source changes, run `yarn build`, commit the affected bundles, and confirm they are synchronized:

```bash
git diff --exit-code dist/main.cjs 'packages/*/dist/'
```

Documentation-only changes must not regenerate or modify `dist`.

### Architecture

See [docs/architecture.md](docs/architecture.md). In short: `review-pipeline` runs triage, propose, judge and render over injected `LlmClient` and `DecisionClient` instances; `run-reviews` does the IO; `root-action/src/orchestrate.ts` holds the shared orchestration for both entry files. Only a leaf `action.ts` owns `require.main === module`.

## Tests

```bash
yarn nx run-many --target=test --skip-nx-cache
(cd packages/root-action && node --test test/*.test.cjs)
```

Tests run against bundles; `yarn nx run <pkg>:test` builds `dist-test/` first. Before opening a pull request that changes behavior, also exercise the action in a private test repository with non-production credentials:

1. Run a `pull_request` review with `pull-requests: write` and confirm an inline review and `comment-url` are produced.
2. Run a `push` or `workflow_dispatch` review with `checks: write` and confirm a check run and `check-run-url`.
3. Run with a bad `decision-api-key` and confirm the run fails with an error comment and posts no partial review.
4. Run on a dist-only diff and confirm a "no reviewable changes" review with no provider calls.

Never expose production credentials to untrusted pull-request code, and do not use `pull_request_target` as a workaround for fork secret restrictions.

## Adding a provider

Each LLM or decision provider is one adapter behind `LlmClient` (`packages/llm-clients`) or `DecisionClient` (`packages/decisions`). Adding one touches only that adapter, its registry, and docs.

1. Write the adapter on the provider's **official SDK**. Check call names against current docs and the installed `.d.ts` files first, and pin the exact version (SDKs here need Node 22+). Adapters never read `process.env`, pass `apiKey` and `baseURL` explicitly (using the provider default when unset), run errors through `redactSecret`, and rely only on the SDK's own retries.
2. Register it in the package's `registry.ts`. The `llm-provider` / `decision-provider` inputs validate against the registry.
3. Make it pass the package's `test/conformance.cjs` against recorded fixtures: schema-valid output, error mapping, retry on transient errors, no secret in logs or errors, timeouts, and env isolation.
4. Add its inputs and an example to `action.yml` and the README tables.
5. Add it to `packages/root-action/test/inputs.test.cjs` and `.github/workflows/smoke.yml`.
6. Run `yarn build && yarn nx run repo-root:build` and commit the bundles and `yarn.lock`.

OpenAI-shaped or Anthropic-shaped gateways need no new adapter: use `llm-provider: openai` or `anthropic` with `llm-base-url`.

## Release gate

Before releasing, run the repeat-stability study and the end-to-end overlap measure against real diffs; see `packages/review-pipeline/study/README.md`. Keep/drop flips must be rare outside the uncertain band.

## Pull requests

Keep changes scoped to one concern, explain any contract change, and include the verification performed. Do not merge behavior that conflicts with the design vision without first updating and approving the design decision.
