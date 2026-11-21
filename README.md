# AI Review Action

AI Review Action reviews pull requests and pushes with a large language model, then judges every proposed finding through a decision API so only well-supported findings are published. One model proposes, a decision model scores each finding against a keep/uncertain/drop policy, and the action posts the result as a batched PR review or a check run.

## Prerequisites

- A **Linux x64** runner (`ubuntu-latest` is fine).
- `actions/checkout` with `fetch-depth: 0` so the action can resolve the base commit and read repository instructions from it.
- `git` on `PATH`.
- A credential for the proposing LLM and one for the decision API, passed as the `llm-api-key` and `decision-api-key` inputs (store them as repository secrets).
- A prompt using the `file:` or `text:` prefix.
- Node 24 on the runner (the action declares `using: node24`; GitHub-hosted runners provide it).

## Quickstart

```yaml
name: AI Review

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      # For production, replace v1 with a full commit SHA.
      - uses: jander99/ai-review-action@v1
        with:
          prompts: file:examples/prompts/code-review.md
          llm-provider: anthropic
          llm-model: claude-sonnet-4-6
          llm-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          decision-provider: systemone
          decision-model: subq-snap-1.2
          decision-api-key: ${{ secrets.DECISION_API_KEY }}
          post-comment: true
```

In production, resolve the `v1` (or `v2`) tag to its full commit SHA and pin the action to it.

## Provider matrix

The proposing LLM and the decision API are chosen independently.

| Role | Input prefix | Supported providers |
|---|---|---|
| Proposing LLM | `llm-` | `openai`, `anthropic`, `gemini` |
| Decision judge | `decision-` | `systemone` (TypeSafe and SubQ), `google` |

Each provider pair needs its own credentials:

```yaml
# OpenAI proposes, SubQ judges
llm-provider: openai
llm-model: gpt-5
llm-api-key: ${{ secrets.OPENAI_API_KEY }}
decision-provider: systemone
decision-model: subq-snap-1.2
decision-api-key: ${{ secrets.SUBQ_API_KEY }}
```

```yaml
# Anthropic proposes, Google judges
llm-provider: anthropic
llm-model: claude-sonnet-4-6
llm-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
decision-provider: google
decision-model: gemini-2.5-flash
decision-api-key: ${{ secrets.GEMINI_API_KEY }}
```

```yaml
# Gemini proposes, TypeSafe judges
llm-provider: gemini
llm-model: gemini-2.5-pro
llm-api-key: ${{ secrets.GEMINI_API_KEY }}
decision-provider: systemone
decision-model: subq-snap-1.2
decision-api-key: ${{ secrets.DECISION_API_KEY }}
```

Any provider can be pointed at a compatible gateway with `llm-base-url` or `decision-base-url`.

## Setup reference: credentials and endpoints

Every run needs one credential for the proposing LLM and one for the decision API, passed as `llm-api-key` and `decision-api-key`. The env var column below lists the conventional secret names you'd store them under.

| Provider | Input value | Conventional secret | Default base URL | Notes |
|---|---|---|---|---|
| OpenAI | `llm-provider: openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1` | OpenAI-shaped. Any compatible gateway (OpenRouter, vLLM, LiteLLM, Azure-style proxies) works via `llm-base-url`. |
| Anthropic | `llm-provider: anthropic` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` | Anthropic-shaped. Works against any Messages-API-compatible endpoint via `llm-base-url` (e.g. MiniMax's `/anthropic`). |
| Gemini | `llm-provider: gemini` | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com` | Same endpoint as the `google` decision provider. |
| TypeSafe | `decision-provider: systemone` | `TYPESAFE_API_KEY` | `https://api.typesafe.ai` | |
| SubQ | `decision-provider: systemone` | `SUBQ_API_KEY` | `https://api.subq.ai` | Same adapter as TypeSafe; pass `decision-base-url: https://api.subq.ai`. Verified wire-compatible. |
| Google | `decision-provider: google` | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com` | |

Most LLM endpoints are OpenAI-shaped or Anthropic-shaped, so those two adapters cover almost everything: if a provider speaks the OpenAI API, use `llm-provider: openai` with its `llm-base-url`; if it speaks the Anthropic Messages API, use `llm-provider: anthropic` with its `llm-base-url`. `gemini` is for Google's native generateContent API. Both roles are required and independent — you can pair any LLM with any decision provider. The adapters do not read keys from the environment themselves: pass the key as `llm-api-key` / `decision-api-key` (the names above are the conventional secret names; `ai-review.yml` passes `secrets.LLM_API_KEY` and `secrets.DECISION_API_KEY` through those inputs).

### GitHub token

`github-token` is optional and defaults to `github.token`. It is only used to publish results:

| Event | Permission needed | What it does |
|---|---|---|
| `pull_request` | `pull-requests: write` | Posts a batched PR review with inline comments. |
| push / `workflow_dispatch` | `checks: write` | Creates a check run. |
| `contents: read` | always | Reads the diff and repository instructions from the base commit. |

Without a token the review still runs and its outputs are still set — it just cannot publish, and the action emits a warning instead of failing.

### Minimal workflow

```yaml
permissions:
  contents: read
  pull-requests: write   # checks: write for non-PR events

steps:
  - uses: actions/checkout@v6
    with:
      fetch-depth: 0     # required: the action resolves the base commit
  - uses: jander99/ai-review-action@v1
    with:
      prompts: file:examples/prompts/code-review.md
      llm-provider: openai
      llm-model: gpt-5
      llm-api-key: ${{ secrets.OPENAI_API_KEY }}
      decision-provider: systemone
      decision-model: subq-snap-1.2
      decision-api-key: ${{ secrets.SUBQ_API_KEY }}
```

### Running the stability study locally

The pipeline's repeat-stability study uses environment variables rather than action inputs:

```bash
DECISION_PROVIDER=systemone \
DECISION_API_KEY=... \
DECISION_MODEL=subq-snap-1.2 \
DECISION_BASE_URL=https://api.subq.ai \  # optional
  yarn nx run review-pipeline:study -- --runs 20
```

## What gets sent where

Your diff, file contents the pipeline reads for context, and the repository instruction files go to the proposing LLM provider. Each proposed finding, with its surrounding context, goes to the decision provider for judging. Both providers see review material; neither sees your other provider's credential.

## Inputs

| Input | Required | Default | Description |
|---|---:|---|---|
| `github-token` | No | `github.token` | Token used to publish the review or check run. Needs `pull-requests: write` on PR events, `checks: write` otherwise. |
| `prompts` | **Yes** | — | Comma-separated prompt sources, each prefixed `file:` or `text:`. |
| `llm-provider` | **Yes** | — | Proposing LLM provider: `openai`, `anthropic`, or `gemini`. |
| `llm-base-url` | No | — | Override the LLM provider base URL. |
| `llm-model` | **Yes** | — | Model id for the proposing LLM. |
| `llm-api-key` | **Yes** | — | API key for the proposing LLM. || `decision-provider` | **Yes** | — | Decision provider: `systemone` or `google`. |
| `decision-base-url` | No | — | Override the decision provider base URL. |
| `decision-model` | **Yes** | — | Model id for the judging decision API. |
| `decision-api-key` | **Yes** | — | API key for the decision provider. |
| `keep-threshold` | No | `0.7` | Minimum support probability to keep a finding. |
| `drop-threshold` | No | `0.3` | Maximum support probability to drop a finding; between the two thresholds it is uncertain. |
| `severity-threshold` | No | `0.5` | Judge severity below this is treated as a suggestion. |
| `review-event` | No | `COMMENT` | PR review event: `COMMENT`, `REQUEST_CHANGES`, or `APPROVE`. |
| `post-comment` | No | `true` | Post the review to the PR (PR events only). |
| `post-check-run` | No | `true` | Post the review as a check run (non-PR events only). |
| `max-comment-chars` | No | `65000` | Truncate the PR review body at this length (GitHub caps comments at 65536). |
| `check-name` | No | `ai-review` | Check run name on non-PR events. |
| `check-conclusion` | No | `neutral` | Check conclusion: `action_required`, `cancelled`, `failure`, `neutral`, `success`, `skipped`, `stale`, or `timed_out`. |
| `check-details-url` | No | `https://github.com` | URL linked from the check run details. |

## Outputs

| Output | Description |
|---|---|
| `review` | The rendered review document (markdown). Empty when there was nothing to review. |
| `triage` | One-line triage of the PR (empty when triage was skipped). |
| `comment-url` | URL of the posted PR review. |
| `check-run-url` | URL of the created check run. |
| `review-output-path` | Runner-local path to the written review document. |
| `findings-kept` | Findings kept after judging and policy. |
| `findings-uncertain` | Findings in the uncertain band (not posted inline). |
| `findings-dropped` | Findings dropped as unsupported, duplicate, or below threshold. |
| `tokens` | JSON token usage: `{ llmInput, llmOutput, decisionInput }`. |
| `failure-reason` | Canonical failure message; empty on success. |

## How it works

1. `run-reviews` resolves the event context, computes the filtered diff, and reads repository instructions from the **base** commit — a pull request cannot change the rules it is reviewed under.
2. The proposer asks the LLM for findings as a schema-validated JSON document.
3. Each finding is judged by the decision API in a small worker pool. Support probability above `keep-threshold` keeps it, below `drop-threshold` drops it, and anything between is uncertain.
4. Kept findings are rendered into the canonical review document with inline comments anchored to the diff. Findings that cannot be anchored inline (deleted files, off-diff lines, cross-hunk ranges) go in the review body instead.
5. A rejected review document is never published: PR events get an error comment, other events get a failing check run.

## Migration from v1

| v1 | v2 |
|---|---|
| `tool: opencode` / `tool: claude` | Removed — the action talks to LLM APIs directly |
| `model: provider/model` | `llm-provider` + `llm-model` |
| `models:` (comma-separated) | Removed — one proposing model per run |
| OpenCode install step (`setup-opencode`) | Removed |
| `opencode-config`, `permission`, `opencode-version`, `claude-version`, `debug`, `timeout-minutes`, `fail-on-error` | Removed |
| `ANTHROPIC_API_KEY` etc. as the only credential path | `llm-api-key` / `decision-api-key` inputs (env vars are not read) |

## Sub-actions

The root action is the consumer-facing entrypoint. The individual packages (`run-reviews`, `post-comment`, `post-check-run`, `post-error-comment`, `previous-reviews`, `review-contract`, `decisions`, `llm-clients`, `review-pipeline`) remain available as standalone sub-actions and libraries for callers who want fine-grained composition.
