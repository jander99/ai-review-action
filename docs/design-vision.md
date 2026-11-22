# AI Review Action — Design

> Status: **v2 implemented.**

## Summary

AI Review Action makes AI reviews more repeatable. An LLM only **proposes** findings as schema-validated JSON. A **decision API** judges every judgment: is the finding supported, how severe, is it a duplicate of a prior finding. Code thresholds the typed probabilities into keep, uncertain or drop. The result is posted as a batched inline PR review, or as a check run on non-PR events.

There is no agent loop, no tool calling and no CLI harness. The reviewer sees the filtered diff, the changed files' text and the base-branch repository instructions, and nothing else.

## Pipeline

1. `previous-reviews` reads prior bot findings (issue comments, inline review comments and review bodies, all pages) with stable finding ids.
2. `run-reviews` computes the filtered diff and reads context and repository instructions from the base commit.
3. **Triage** (decision API) asks PR-level questions, gates review depth (light or detailed) and emits a triage line.
4. **Propose** (LLM): one call returns findings; invalid JSON gets one retry.
5. **Judge** (decision API): one request per finding, 3 at a time. Any finding unjudged after the SDK's retries fails the run; a partial review is never posted.
6. **Policy** (`review-contract`): `P(supported) >= keep-threshold` keeps, `<= drop-threshold` drops, between is uncertain (rendered collapsed). Severity is the argmax if it clears `severity-threshold`, otherwise the lower neighbour. Duplicates of prior findings are dropped and counted.
7. Render the canonical review document and post it. Findings that cannot be anchored to a diff hunk go in the review body, never dropped.

## Packages

- `review-contract`: review format, parser/validator, merge, policy, diff parsing, finding comments, proposer schema. The single source of truth for the format.
- `decisions`, `llm-clients`: provider adapters on official SDKs behind `DecisionClient` and `LlmClient`, each with a registry and a shared conformance suite.
- `review-pipeline`: `runReviewPipeline(input, deps)`, pure orchestration over injected clients; plus the repeat-stability study.
- `run-reviews`: IO (event context, diff, instructions) and the call into the pipeline.
- `previous-reviews`, `post-comment`, `post-check-run`, `post-error-comment`: GitHub IO.
- `root-action`: shared orchestration and the action entry points.

## Contracts

- **Provider adapters** take `{baseUrl?, apiKey, model, timeoutMs?, options?}`. They never read `process.env`, pass key and base URL explicitly to the SDK, redact secrets from errors, and use only the SDK's built-in retries. There is no fallback from the decision API to an LLM.
- **Untrusted input:** PR content is fenced data; repo instructions come from the base SHA; judge state is JSON-encoded.
- **Failure behavior:** decision API down, or any finding unjudged, fails the check with an error comment. A proposer that returns no valid findings after one retry posts "no findings produced", not a clean pass.
- **Default posture:** a `COMMENT` review. `APPROVE` and `REQUEST_CHANGES` are opt-in and apply only to completed reviews.

## Release gate

Before a release, run the repeat-stability study and the end-to-end overlap measure (`packages/review-pipeline/study/README.md`) against real diffs. Keep/drop flips must be rare outside the uncertain band; tune default thresholds from the reports.

## Related documentation

- [README](../README.md), [Contributing](../CONTRIBUTING.md), [Security policy](../SECURITY.md), [Architecture](architecture.md).
