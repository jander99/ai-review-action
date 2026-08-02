# AI Review Action — Current Design

> Status: **implemented core action; contract coverage and documentation follow-up remain.**

## Summary

AI Review Action runs repository reviews through the OpenCode CLI in GitHub Actions. The workflow supplies the runner, checkout, credentials, prompts, optional configuration, skills, MCPs, and plugins. The action owns the review agent, runtime configuration, invocation orchestration, result aggregation, and publication.

The root action (`packages/root-action`) is a single JavaScript bundle that wires `run-reviews`, `validate-review`, `post-comment`, `post-check-run`, and `post-error-comment` together. Each leaf package exports a plain TypeScript API (`runReviews`, `validateReview`, `postComment`, `postCheckRun`, `postErrorComment`) and the leaf action's `dist/main.cjs` is a thin wrapper that translates `@actions/core` inputs and outputs. The bundle uses `require.main === module` to gate the action entrypoint, so the same file can also be imported as a library.

The sub-actions remain available for callers who want fine-grained composition:

- `setup-opencode` installs a pinned Linux x64 OpenCode release after verifying its SHA-256 checksum.
- The root action asserts the installed OpenCode version before reviewing.
- `run-reviews` removes workspace-root `opencode.json` and `opencode.jsonc`, builds an isolated merged configuration under the runner temp directory, and uses an isolated OpenCode home.
- The action injects event/ref context into an action-owned agent definition. It does not materialize a diff; the model uses Git to decide what to inspect.
- Prompts use `file:` or `text:` sources. `models` and `prompts` are cross-producted in stable lexical order.
- Optional fusion sanitizes and size-limits individual reviews and runs a tool-disabled synthesis pass.
- Results expose review text, successful models, cost, and token totals, including per-model JSON outputs.
- Pull requests publish comments; non-PR events publish check runs. Publishing can be disabled independently.
- Debug mode captures stdout/stderr, applies best-effort credential redaction, compresses the files, and uploads a short-lived artifact.
- Prior AI review comments for the same pull request are fetched, sanitized, and size-capped, then injected into the reviewer prompt so status changes (`unresolved`, `resolved`) propagate to the next run.
- The validator runs a deterministic structural check first and a model-based check second; the model only sees a sanitized config that does not embed the reviewer prompt, the runner-local path, or any literal user secret.

## Runtime and security contracts

- Supported execution target: Linux x64. The bundled installer does not support macOS, Windows, or Linux arm64.
- OpenCode installation is separate from review execution. Production workflows should pin both action references to a full commit SHA and provide the checksum for the exact OpenCode archive.
- Provider credentials remain environment variables and are referenced through OpenCode `{env:VAR}` configuration values. Supported built-in integrations include Anthropic, OpenAI, Gemini, GitHub Copilot, MiniMax, Kimi/Moonshot, AWS Bedrock, and Google Vertex Anthropic.
- Default permissions allow reading and Git inspection; edits, questions, and loop-breaking require confirmation; Bash is allowed unless the workflow overrides the `permission` input. OpenCode does not provide a reliable Bash sub-command allow-list.
- The workflow author is the trust boundary. A model with Bash access may read or exfiltrate environment variables, repository instructions can influence behavior, fork workflows normally lack provider secrets, and review completeness is not guaranteed.
- Debug redaction is pattern-based and is not a guarantee that source, prompts, model output, URLs, or unknown secrets are absent from artifacts.

## Remaining work

1. Add contract fixtures/tests for the pinned OpenCode 1.18.5 CLI and JSONL result ABI.
2. Decide whether merged OpenCode configuration should gain schema validation. Earlier design text described this, but the current implementation does not validate against `$schema`.
3. Keep user-facing documentation aligned when action inputs, provider fallbacks, or OpenCode runtime contracts change.

## Related documentation

- [README](../README.md) — setup, inputs, outputs, examples, and operational limitations.
- [Contributing](../CONTRIBUTING.md) — local development and verification commands.
- [Security policy](../SECURITY.md) — threat model, supply-chain guidance, and reporting.
