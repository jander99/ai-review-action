# Contributing

Thank you for improving AI Review Action. The [design vision](docs/design-vision.md) is the source of truth for architecture, security boundaries, inputs, outputs, and runtime behavior. Review the design vision before changing a contract.

## Local development

The repository is an Nx monorepo managed with Yarn 4. Source lives under `packages/*/src`, and each action's committed bundle lives under `packages/*/dist`. The root action is a single JavaScript bundle under `packages/root-action/`.

Prerequisites:

- Linux or macOS for local TypeScript development; the `setup-opencode` action itself supports Linux x64 only.
- Node.js 20 or newer.
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
git diff --exit-code \
  packages/root-action/dist/ \
  packages/run-reviews/dist/ \
  packages/validate-review/dist/ \
  packages/setup-opencode/dist/ \
  packages/post-comment/dist/ \
  packages/post-check-run/dist/ \
  packages/post-error-comment/dist/
```

Documentation-only changes must not regenerate or modify `dist`.

### Architecture

The root action is a single JS bundle that wires the package APIs together. The bundled code uses `if (require.main === module)` to gate its top-level IIFE, so the same bundle can also be required as a library (e.g., by future tests) without running the action entrypoint. Each leaf package exports its pipeline as a plain TypeScript function (`runReviews`, `validateReview`, `postComment`, `postCheckRun`, `postErrorComment`) and the leaf action's `dist/main.cjs` is a thin wrapper that translates `@actions/core` inputs and outputs.

## Smoke tests

There is not yet an automated OpenCode contract-fixture suite. Before opening a pull request that changes behavior, run the build and type-check commands above, then exercise the action in a private test repository or trusted test pull request.

Use a real Linux x64 release archive and non-production credentials to verify the affected paths:

1. Run `setup-opencode` with the correct SHA-256 and confirm the requested version is placed on `PATH`.
2. Change one checksum character and confirm installation fails before extraction.
3. Set the root action's `opencode-version` to a different version and confirm the version assertion fails.
4. Run a `pull_request` review with `pull-requests: write` and confirm a comment and `comment-url` are produced.
5. Run a `push` or `workflow_dispatch` review with `checks: write` and confirm an `ai-review` check run and `check-run-url` are produced.
6. When changing orchestration, exercise multiple prompts/models, fusion success and failure, partial results, and both values of `fail-on-error`.
7. When changing debug capture, enable `debug`, download `ai-review-debug`, confirm files are gzipped, and inspect them for unredacted synthetic credential patterns. Treat the artifact as sensitive even when the check passes.

Never expose production provider credentials to untrusted pull-request code, and do not use `pull_request_target` as a workaround for fork secret restrictions.

## Updating OpenCode

OpenCode behavior is a versioned ABI. To update the supported version:

1. Select the Linux x64 `opencode-linux-x64.tar.gz` release asset from `anomalyco/opencode`.
2. Download that exact asset and calculate its SHA-256 with `sha256sum opencode-linux-x64.tar.gz`.
3. Add the new version, asset name, and concrete SHA-256 to the README's **Vetted OpenCode versions** table. Update every README sample to use that same value.
4. Bump the `opencode-version` default in the root `action.yml` and the `version` default in `packages/setup-opencode/action.yml`. Keep the fallbacks and assertions in `packages/setup-opencode/src/main.ts`, `packages/run-reviews/action.yml`, and `packages/run-reviews/src/main.ts` aligned.
5. Run the installer and ABI smoke tests with the new version and checksum.
6. Run `yarn build`, type-check every package, and commit synchronized `dist` bundles.

A checksum is tied to one exact archive. Never copy a checksum between versions, platforms, filenames, or rebuilt assets.

## Adding a provider

OpenCode-native providers generally require only README documentation and an environment-variable example. A built-in custom provider belongs in `builtInProviders()` in `packages/run-reviews/src/config-builder.ts`.

For a custom provider:

1. Choose a stable provider identifier and the required AI SDK npm package.
2. Inject the provider only when its credential environment is present.
3. Reference credentials with `{env:VAR}`; never place secret values in the generated config or logs.
4. Define only the provider defaults the action owns. Leave user-specific model, region, project, or endpoint configuration composable where possible.
5. Verify behavior with the credential absent, with each documented credential alias, and with a user-provided config.
6. Update the provider table and add a complete checkout → setup → review sample when the provider needs non-obvious configuration.
7. Build, type-check, and run a trusted smoke review.

Provider changes alter the security and supply-chain surface. Keep dependencies minimal and document every environment variable read by the action.

## Writing tests and ABI contract fixtures

The deferred contract suite must cover every claim described as verified against a specific OpenCode version. Keep pure unit tests separate from captured CLI fixtures.

Each versioned fixture should record:

- OpenCode version, Linux x64 asset name, and SHA-256;
- the exact non-interactive CLI command and environment shape;
- representative JSONL events, including review text and `step_finish` cost/token fields;
- expected exit status, stderr behavior, and timeout behavior; and
- permission/config assumptions relevant to the assertion.

Contract tests should verify at least:

- `opencode --version` parsing and mismatch failure;
- `opencode run <prompt> --model <provider/model> --format json` argument compatibility;
- JSONL parsing, including malformed lines and the expected cost/token shape;
- tool-disabled fusion behavior and stable result accounting; and
- config/permission behavior on the pinned OpenCode version.

Fixtures must contain no live credentials or repository-sensitive content. Capture them from a pinned binary, sanitize them once, and review fixture changes as ABI changes rather than updating snapshots merely to make a test pass. Live-provider smoke tests should remain opt-in and separate from deterministic CI tests.

## Pull requests

Keep changes scoped to one concern, explain any contract change, and include the verification performed. Do not merge behavior that conflicts with the design vision without first updating and approving the design decision.
