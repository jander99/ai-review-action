# Decision-API review pipeline — design

Status: all open decisions resolved; ready for approval. Date: 2026-11-19.

## Intent

Make AI reviews more repeatable. Today an LLM run through a harness
(OpenCode or Claude Code CLI) both finds issues and judges them, and its
free-form output is non-deterministic. Decision APIs ("System One"-style
models) return typed, probabilistic answers (`noul`, `choice`, `score`) to
named questions. Use them for every judgment; use the LLM only to propose
findings. Replace the harnesses with TypeScript code that talks to
providers directly.

## Goals

- Verdicts (supported / severity / duplicate) come from a decision API and
  are thresholded in code, with a fallback band for borderline answers.
- LLM output is schema-validated JSON; no format-retry loop on prose.
- Provider is configured by endpoint URI + token + model inputs.
- Delete the opencode/claude runtimes, `setup-opencode`, and the
  OpenCode-version bump process.
- Providers are pluggable: each LLM or decision provider is an adapter
  behind a small interface, so adding one later touches only that
  adapter, the registry, and docs (see "Adding a provider").

## Non-goals

- No repo-exploring agent or tool-calling loop. The reviewer sees the diff
  plus fetched context only (decided).
- No self-hosted models. No images/audio in v1.
- No guarantee of bit-identical repeat runs (no vendor offers a seed).

## Anti-goals

- Sending more to third parties than the diff, the changed files' fetched
  context, and the repo instruction files. Note the code goes to two
  third parties (LLM provider and decision provider); users opt into
  both by configuring them.
- Silent fallback to an LLM judge when the decision API fails.

## Findings that constrain the design (vendor docs, read 2026-11-19)

| API | Endpoint | Auth | Input field | Notes |
|---|---|---|---|---|
| TypeSafe Jev | `POST api.typesafe.ai/v1/systemone` | `Authorization: Bearer` | `state` | `model`, `questions` map; types noul/choice/score/box |
| SubQ | `POST api.subq.ai/v1/systemone` | `Authorization: Bearer` | `state` | same shape; `images` instead of `assets`; 384K ctx |
| Google | `POST generativelanguage.googleapis.com/v1beta/decisions` | `x-goog-api-key` | `input` (text/content blocks) | `model: gemini-decision-1`; 262K ctx; noul clamped 0.01–0.99 |

- TypeSafe and SubQ share one wire shape; Google needs its own adapter.
- None documents seed, temperature, or a repeatability guarantee. Output
  tokens are free; input is ~$0.04–0.10 per 1M tokens.
- Input limits (262K–384K tokens) cap the embedded diff per request.
- Vendor claims are unverified by us. Verified-by-us requirement: a
  repeat-stability test (below) before shipping.

## Approaches considered

1. **Replace in place (chosen).** New packages, rewrite pipeline, remove
   old runtimes, ship as sequenced PRs and a major version.
2. Add `tool: api` beside opencode/claude. Rejected: keeps two review
   paths alive, against the goal.
3. Decision layer first, harness for generation. Rejected: leaves the
   generation step on the harness the user wants gone.

## Design

### Pipeline

1. `previous-reviews` fetches prior bot output: issue comments **and**
   inline review comments (separate API), each with a stable finding id
   (embedded as a hidden marker) so `duplicate_of_prior` can reference it.
   Pagination must not silently cap at 50.
2. **Context builder:** diff (existing pathspec filter, cap
   `REVIEW_DIFF_MAX_BYTES`) plus full text of changed files under a byte
   cap; truncation is explicit and noted in the prompt. The proposer input
   is also capped to its model's window (`maxInputTokens`); context files
   are dropped before the diff is trimmed.
   **Untrusted input:** diff, file text, and repo instruction files are
   delimited data in the prompt; repo instructions are read from the
   **base** branch (the PR author controls the head), and proposer output
   is treated as untrusted when it enters the judge's `state`.
3. **Proposer (LLM):** one adapter call returns findings as JSON validated
   against a schema (file, line range, title, claim, evidence, suggested
   fix). Invalid JSON gets one retry with the validation error.
4. **Judge (decision API):** one request per finding, run through a
   worker pool of 3 concurrent requests, one shared `state`
   (the finding with its evidence, the diff hunks for every file the
   finding references, and the relevant slices of those files' fetched
   context — so the judge sees what the proposer saw), several named
   questions:
   - `supported` (noul): does the diff support the claim?
   - `severity` (choice): blocker / major / minor / nit.
   - `duplicate_of_prior` (choice over prior finding ids + `none`).
5. **Policy (deterministic, in `review-contract`):** keep a finding if
   `P(supported) >= T_keep`; drop if `<= T_drop`; otherwise mark
   "uncertain" and render it in a separate section. Severity is the argmax
   if its probability clears `severity-threshold` (default 0.5), else the
   lower neighbour. A finding whose `duplicate_of_prior` is not `none` at
   `>= T_keep` is dropped from posting (counted in the summary).
   Thresholds are inputs with documented defaults (start 0.7 / 0.3 / 0.5).
6. Existing merge/render, `post-comment`, `post-check-run`,
   `post-error-comment` consume the result. Structural validation stays in
   code; the LLM validator call is removed.

### Packages

- `packages/review-pipeline`: the orchestration itself — `runReviewPipeline(deps)`
  over injected clients and context, no `@actions/core`, no env reads, no
  `process.exit`. `run-reviews` and `root-action`'s two entry points become
  thin wrappers that read inputs, build clients, call it, and dispatch
  results, so the `main.ts` / `action-entry.ts` duplication rule is enforced
  by structure rather than discipline.
- `packages/llm-clients`: `LlmClient` interface
  (`complete(request): Promise<{text, usage}>`, JSON-schema output mode)
  with one adapter per official SDK (decided: use typed SDKs, not raw
  `fetch`):
  - `openai`: `openai` package, `responses.create` with
    `text.format = {type: "json_schema", strict: true}`; `baseURL`
    option covers OpenAI-compatible endpoints.
  - `anthropic`: `@anthropic-ai/sdk`, `messages.parse` with
    `output_config.format = jsonSchemaOutputFormat(schema)`; `baseURL`
    option for Anthropic-compatible endpoints.
  - `gemini`: `@google/genai`, `generateContent` with a response schema
    and JSON mime type; pass `seed` and low `temperature` (best-effort
    repeatability for the proposer).
- `packages/decisions`: `DecisionClient` interface. Adapters, again on
  official SDKs:
  - `systemone`: `@typesafe-ai/sdk` (`TypeSafeClient.systemOne`, typed
    `choice`/`score`/`noul` helpers). Its `baseURL` option posts to
    `${baseURL}/v1/systemone` with a bearer key, so SubQ (same path and
    shape) works by changing `baseURL`/`model` — verified live 2026-11-19:
    `@typesafe-ai/sdk` 0.7.0 against `https://api.subq.ai` with
    `subq-snap-1.2` returned typed noul/choice answers.
  - `google`: `@google/genai` `decisions.create` (needs
    a recent `@google/genai` and `apiVersion: "v1beta"`; the "3.2" floor
    in Google's docs is the Python `google-genai` package, so verify the
    npm version at implementation time).
  Retries: use each SDK's built-in retry policy (backoff on 429/503/529);
  no fallback to an LLM.
- `run-reviews` and `validate-review` are rewritten on these; their
  action entry points keep `require.main` ownership. `validate-review` may
  be folded into `run-reviews` if it ends up as only deterministic checks
  (builder's call).

### Adding a provider (extensibility)

The pipeline depends only on two interfaces; it never imports a vendor SDK.

- `LlmClient`: `complete({system, prompt, jsonSchema, seed?, maxTokens})`
  where `maxTokens` defaults to 4096 per adapter and is set explicitly by
  the proposer. Returns `{value, usage}` where `value` is already parsed JSON that the
  adapter has checked against `jsonSchema`. Each adapter owns its
  provider's structured-output mechanism, auth, base URL, retries, and
  mapping of provider errors to a shared `LlmError` (rate-limit,
  auth, context-too-long, refusal, transient, other).
- `DecisionClient`: `decide({state, questions})` returns typed answers
  (`noul`, `choice`, `score`, each with probabilities) and `usage`, with
  a shared `DecisionError` taxonomy. The common question model is
  provider-neutral; each adapter translates it (for example, `state` to
  Google's `input`).
- **Registry:** one map per interface from provider id to a factory
  `(config) => client`, in `llm-clients` and `decisions`. The action's
  `llm-provider` and `decision-provider` inputs are validated against
  registry keys, so the allowed list and error messages come from code,
  not duplicated docs.
- **Shared config shape:** `{baseUrl?, apiKey, model, timeoutMs?}` plus an
  optional adapter-specific `options` object, so OpenAI-compatible and
  Anthropic-compatible gateways are config, not new adapters.
- **Capability flags** on each adapter (for example `supportsSeed`,
  `maxInputTokens`) so the context builder and policy adapt without
  provider `if` statements.
- **Conformance suite:** a shared test file that every adapter must pass
  against recorded fixtures: schema-valid output, error mapping, retry on
  transient errors, no secret in logs or errors, and timeout behavior. A
  new adapter is done when it passes the suite.
- **Checklist to add one:** (1) write the adapter on the provider's
  official SDK, verifying current docs first; (2) register it; (3) pass
  the conformance suite; (4) add its inputs and an example to `action.yml`
  and README tables; (5) add it to `inputs.test.cjs` and `smoke.yml`;
  (6) rebuild and commit `dist/`.
- Initial adapters: LLM `openai`, `anthropic`, `gemini`; decisions
  `systemone` (TypeSafe, SubQ via `baseUrl`) and `google`.

### Action inputs (sketch)

`llm-provider` (`openai|anthropic|gemini`), `llm-base-url`, `llm-model`,
`llm-api-key`; `decision-provider` (`systemone|google`),
`decision-base-url`, `decision-model`, `decision-api-key`;
`keep-threshold`, `drop-threshold`, `severity-threshold`. Remove `tool`. Secrets are masked;
env stays an allow-list; nothing spreads `process.env`. Update
`action.yml`, README tables, `inputs.test.cjs`, `smoke.yml`.

### Failure behavior

- Decision API unavailable after retries: fail the check with an error
  comment; do not post an unjudged review. Partial failure (any finding
  unjudged after retries) is treated the same: fail, never post a subset
  as if complete.
- LLM returns no valid findings after retry: post "no findings produced"
  with a warning, not a clean pass.
- Over-size input: truncate context, never the diff first; if the diff
  alone exceeds the decision model's window, split findings across
  requests with the diff chunked by file; a finding spanning files gets
  the hunks of all files it references, and if those alone exceed the
  window it is rendered as "unjudged: too large" in the uncertain band.

## Review output shape (parity with Copilot / Claude code review)

- **Inline comments are required.** Findings post as a batched GitHub review
  (pending review -> inline comments -> submitted summary), not one wall of
  markdown. The canonical document becomes the review's summary body; each
  finding maps to an inline comment anchored to its file and line range.
  `post-comment` grows a review-API path beside its comment path.
  GitHub rejects (422) comments on lines outside the diff hunks, so
  anchors are checked against the diff first; a finding that cannot be
  anchored is rendered in the summary body instead, never dropped.
- **Suggested changes.** A finding's suggested fix renders as a
  ```suggestion block where the line range allows, so it is one-click
  appliable like Copilot's.
- **Repo-level instructions are fed in.** Repo instruction files are read
  from the base branch (the PR author controls head, so head is an
  injection vector) and injected into the proposer
  prompt alongside the action's prompt input.
- **PR-level decision questions.** Because a decision API is available, ask
  questions about the pull request itself (not just per finding) and feed
  the answers back into the review. The point is a review that triages the
  PR rather than a vanilla pass over the diff: typed answers about scope,
  risk, size, and whether the change matches its stated intent can
  - **gate depth** — a low-risk, small, intent-matching PR gets a light
    review; anything flagged gets the detailed one, and
  - **produce a triage line up front** — a short Staff-SE-facing signal
    ("safe to skim and approve" vs "scrutinize: touches auth +
    concurrency") so a human knows how hard to read before they start.
  Answers are typed and thresholded like any other decision. Open: the exact
  question set, and whether triage runs before propose (so it can steer what
  the proposer looks for) — the working assumption is yes.
- **Uncertain band is rendered collapsed.** Keep the separate section for
  repeatability, but collapse it by default with a count in the summary, so
  it reads as a footnote rather than noise.
- Default posture matches the incumbents: a **Comment** review, not
  Approve or Request changes, unless configured otherwise.

## Resolved decisions (2026-11-19)

These were open questions in the draft and are now settled:

1. **Judge concurrency: a pool of 3 workers.** Per-finding decision requests
   run 3 at a time, not serially.
2. **`maxTokens` default: 4096**, overridable per call; the proposer sets it
   explicitly.
3. **SubQ is a first-class decision target, verified live.** `@typesafe-ai/sdk`
   0.7.0 pointed at `https://api.subq.ai` with `subq-snap-1.2` returned typed
   noul/choice answers, so the `systemone` adapter covers TypeSafe and SubQ by
   config — no separate adapter, no remaining compatibility gate.
4. **Inline comments are required** — batched review, not a single comment.
5. **Suggested changes** render as suggestion blocks.
6. **Repo-level instructions** are fed into the proposer prompt.
7. **PR-level triage questions** gate review depth and emit a triage line.
8. **Uncertain band renders collapsed** by default.
9. **Per-finding judging**, not one request for the whole review.
10. **No LLM fallback**: if the decision API is down, or any finding is
    unjudged after retries, the check fails.
11. **Triage runs before propose** so its answers gate depth and steer the
    proposer.
12. **Repo instructions are read from the base branch**, not head.

## Testing and verification

- Contract tests for each adapter against recorded fixtures.
- Policy unit tests around the thresholds.
- **Repeat-stability study (gate before release):** run the judge N=20
  times on ~10 real diffs from this repo; report the spread of
  `P(supported)` and the rate of keep/drop flips. Ship only if flips are
  rare outside the uncertain band. A second, end-to-end measure runs the
  full pipeline N times on the same diffs and reports finding-set overlap
  (the proposer is still non-deterministic, so judge stability alone does
  not show repeatability). The judge study only needs the judge plus the pure
  policy, so it can run against a minimal harness early (PR 1) and be
  re-run on the real pipeline later.
- `dist/` rebuilt and committed per repo rules; both orchestration copies
  (`main.ts`, `action-entry.ts`) updated.

## Sequencing (separate PRs)

1. `decisions` package + stability study script (the study runs against a
   minimal judge harness — judge + pure policy — before the rest exists).
2. `llm-clients` package.
3. `review-pipeline` package: orchestration, context builder, policy,
   repo-instruction ingestion, PR-level triage.
4. Output: inline batched review in `post-comment`, `previous-reviews`
   inline-comment support, suggestion blocks, collapsed uncertain band.
5. Wire `run-reviews` / `root-action` to the pipeline, new inputs.
6. Remove opencode/claude runtimes, `setup-opencode`, docs, major version.

## Open items left to the builder

- Exact prompts and JSON schema fields; exact threshold defaults after the
  stability study; whether `validate-review` survives as a package.
- Per-provider structured-output mechanism (verify with current docs at
  implementation time: OpenAI, Anthropic, and Gemini's current text API).
- Gemini text-model choice: the docs I read conflicted on the current
  model list; confirm before writing the adapter.

## Calls I made (not yet agreed)

None open. SDK versions are pinned at implementation time from the npm
registry, and the esbuild bundle size is checked since `dist/` is committed.
