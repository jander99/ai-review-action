# AI Review Action — Design Vision

> Status: design / pre-implementation. The repo contains a Copilot-CLI-based
> prototype (see `README.md`). This document describes the design of the
> reimagined action built on the OpenCode CLI.

## 1. Goal

An action that:

- Shells out to the **OpenCode CLI** as the runtime harness
- Accepts **API keys per provider** via env vars (no Copilot PAT)
- Lets the **workflow own the runtime**: skills, MCPs, plugins, providers —
  declared in `opencode.json` or composed in workflow steps
- Owns the parts only it can own: the **action-owned agent definition**, the
  **composed `opencode.json` with required settings injected**, result
  aggregation, and comment/check-run posting
- Surfaces **cost and tokens** in outputs for every result
- Supports **multi-model, multi-prompt, and fusion** as optional orchestrations
- **Never materializes a diff**. The model decides what to review.

## 2. Prerequisites

**Runner**: Linux (`ubuntu-latest` or self-hosted). macOS and Windows are
not supported.

**Required binaries** on `PATH`:

- `curl` (composite `setup-opencode` step)
- `npx` (Node 22+, for skill/MCP tools)
- `git` (the model uses it to determine what to review)
- `bash`
- `opencode` (composite step installs; the action asserts version)

**Required environment**:

- Provider API keys as env vars (e.g. `ANTHROPIC_API_KEY`). The action never
  reads them directly; the merged `opencode.json` interpolates via `{env:VAR}`.
- `GITHUB_TOKEN` (default permissions suffice for `pull_request` reviews).

**Required checkout** (strict, the action asserts):

- `actions/checkout@v6` with `fetch-depth: 0`
- The base ref must be fetched — `origin/$BASE_REF` must exist before the
  action runs. The action fails fast with a clear error if it doesn't.

## 3. Quickstart

Minimal runnable example. Uses the composite `setup-opencode` step.

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
        with: { fetch-depth: 0 }

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: <sha256-of-installer>

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:.github/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The prompt tells the model what to do. The action injects runtime context
(event, refs, branch) into the **agent definition** so the model knows it
is reviewing a pull request and can pull `git diff` itself.

## 4. Problem

The prototype in this repo is a thin wrapper around the **GitHub Copilot CLI**:

- Shells out to `copilot -p <prompt>` with a fine-grained PAT (`copilot-token`)
- Models limited to whatever the user's GitHub Copilot subscription exposes
- Prompts are first-class inputs (`code-review`, `security-review`, etc.)
- Tool access restricted to `shell(git:*)` via `--allow-tool`
- Multi-model runs and fusion are orchestrations the action owns

That's the limitation. Three things are hard to express:

1. **API-key-only multi-provider**. No Claude-direct, OpenAI-direct, MiniMax,
   Kimi — only what GitHub Copilot routes.
2. **User-composable runtime**. The action owns prompts, models, tool access.
   A user wanting a custom MCP server or plugin has to fork.
3. **Reproducible agent environments**. The runtime is whatever the runner
   happens to have. No pin, no cache, no reproducibility.

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Actions Workflow                     │
│                                                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │ setup-opencode  │  │ Install Skills  │  │ Skill config │  │
│  │ (composite step) │  │ (npx skills add) │  │ (text/file)  │  │
│  │ pinned, checksum │  │                  │  │              │  │
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘  │
│           │                    │                  │          │
│  ┌─────────────────┐  ┌────────▼────────┐         │          │
│  │ actions/checkout│  │ Delete on-disk  │         │          │
│  │ fetch-depth: 0  │  │ opencode.json   │         │          │
│  └────────┬────────┘  └────────┬────────┘         │          │
│           │                    │                  │          │
│           └────────────────────┴──────────────────┘          │
│                                │                             │
│                                ▼                             │
│              ┌────────────────────────────────┐             │
│              │  jander99/ai-review-action@v1   │             │
│              │  ┌──────────────────────────┐  │             │
│              │  │ run-reviews              │  │             │
│              │  │  · build merged config   │  │             │
│              │  │  · inject agent def      │  │             │
│              │  │  · compose task prompt   │  │             │
│              │  │  · opencode run × N      │  │             │
│              │  │  · aggregate + fusion    │  │             │
│              │  └──────────────────────────┘  │             │
│              │  post-comment    → PR comment   │             │
│              │  post-check-run  → check run    │             │
│              └────────────────┬───────────────┘             │
│                               │                              │
│  Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.             │
│  Token:  GITHUB_TOKEN (read-only)                             │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼ shell: opencode run
┌─────────────────────────────────────────────────────────────────┐
│                       OpenCode Runtime                         │
│  · agent definition (action-owned, privileged)                 │
│  · providers (anthropic, openai, minimax, kimi, bedrock,       │
│    vertex, plus user-declared)                                 │
│  · mcp servers (auto-spawned from opencode.json)               │
│  · plugins (loaded from opencode.json)                         │
│  · skills (auto-discovered from .claude/, .opencode/, .agents/)│
│  · permissions (read/glob/grep/list/webfetch allow;            │
│    edit/question/doom_loop ask; bash: allow)                   │
└─────────────────────────────────────────────────────────────────┘
```

The action has three pieces:

1. **`setup-opencode`** (composite step) — downloads OpenCode from a pinned
   URL with checksum verification. Independent of the main action — usable
   from any workflow.
2. **`run-reviews`** — pre-run cleanup, builds the merged `opencode.json`,
   injects the agent definition, composes the prompt, calls `opencode run`,
   parses `--format json`, aggregates results.
3. **`post-comment`** (or `post-check-run` for non-PR events) — publishes
   the result. Posts partial results on failure.

## 6. Key Decisions

### 6.1 Permission defaults are explicit per-tool

OpenCode's permission engine is **all-or-nothing at the tool level**: the
flat `{ "bash": "allow" }` shape works, but nested shapes like
`{ "git *": "allow", "*": "deny" }` deny the tool entirely (verified on
1.18.4). Sub-command allow-lists do not work.

The action's generated `opencode.json` defaults to **explicit per-tool
permissions**:

```json
{
  "permission": {
    "read":     "allow",
    "glob":     "allow",
    "grep":     "allow",
    "list":     "allow",
    "webfetch": "allow",
    "edit":     "ask",
    "question": "ask",
    "doom_loop": "ask",
    "bash":     "allow"
  }
}
```

Reviews are **read-only by construction** — the model can read files and
run shell, but every edit goes through a human-in-the-loop prompt. Users
can override the entire block via the `permission` input.

### 6.2 API keys via env vars, non-interactive

`opencode run` reads per-provider env vars at startup. `opencode auth login`
is interactive (TTY required) and has no `--api-key` flag. The only
CI-safe path is env vars.

The action never handles auth itself. The workflow injects env vars
(see §9); the merged `opencode.json` interpolates them via `{env:VAR}`.

Precedence: env vars > stored credentials (`~/.local/share/opencode/auth.json`)
> `.env` files. A fresh GitHub Actions runner has no stored credentials, so
env vars just work.

### 6.3 Multi-model / multi-prompt / fusion are optional

All three are first-class inputs but all default off:

- **Single model, single prompt** is the default
- **`models:`** — multi-model runs (same prompts, multiple models)
- **`prompts:`** — multi-prompt runs (same model, multiple prompts)
- **`fusion:`** — synthesis pass combining all individual results

The action cross-products `models × prompts` and calls `opencode run` once
per combination. Results are aggregated in **stable lexical order** (prompts
first, then models) so the same inputs always produce the same output.

### 6.4 Cost and tokens surfaced in outputs

`opencode run --format json` emits `step_finish` events with `tokens` and
`cost` per call (verified in OpenCode 1.18.4). The action parses JSONL,
aggregates, and surfaces cost and token usage in outputs (see 7.2).

### 6.5 Runtime responsibility split — workflow installs, action asserts

The workflow installs OpenCode via the composite `setup-opencode` step.
The action's `opencode-version` is a **version assertion**: the action
fails fast if the installed binary doesn't match.

| Concern | Prototype (Copilot CLI) | Reimagined (OpenCode) |
|---|---|---|
| Install runtime | `action.yml` inline | `setup-opencode` composite step |
| Install skills | not supported | `npx skills add` |
| `opencode.json` | not supported | workflow (optional) + action builder merges required settings |
| Install plugins | not supported | `opencode.json` plugin field |
| Inject auth | `copilot-token` input | env vars |
| Permission model | `--allow-tool=shell(git:*)` | explicit per-tool allow/ask |
| Runtime pin | none | composite step pins, action asserts |

### 6.6 Context-aware prompts — the model decides what to review

The action does **not** materialize a diff. There is no `target` input, no
`diff` vs `full` mode, no auto-resolution. The model figures out what to
review based on the context the action injects into the **agent definition**.

The action pulls runtime context from `github.event_name`,
`github.event.*`, and the resolved refs, and injects it into the agent
template:

- `pull_request`: `event_name`, `pr_number`, `base_ref`, `head_ref`,
  `base_sha`, `head_sha`, `repo`
- `push`: `event_name`, `ref`, `before`, `after`, `repo`
- `workflow_dispatch`: `event_name`, `inputs`, `repo`

The agent definition renders with these values. The model is told what
context it is in and figures out what to review — typically
`git diff origin/$BASE_REF...HEAD` for a PR, or `git log $BEFORE..$AFTER`
for a push. A model that cannot reason its way to `git diff` from the
context is the wrong model for the job.

### 6.7 On-disk config cleanup (A1)

Before generating the merged config, the action **deletes any
`opencode.json` or `opencode.jsonc` from the working directory**. The only
opencode.json that matters is the one the action builds. This neutralizes
the PR-controlled config injection vector (MCPs, plugins, agents declared
in a PR-committed `opencode.json`).

Skills directories (`.claude/`, `.opencode/`, `.agents/`) are NOT cleaned
by the action — they're installed by the workflow via `npx skills add` and
are part of the user's composition. AGENTS.md is also untouched (the model
reads it like any file).

### 6.8 Agent definition — privileged instructions live in config (C1)

The action's privileged instructions (output format, severity legend,
behavior defaults, event-context rendering) live in the **action's
agent definition** in the merged config's `agent` field. The
prompt passed to `opencode run` is the **task**, not the privileged
instruction.

This matters because the prompt is a positional arg to `opencode run`,
which makes it a user message competing with repo `AGENTS.md` and
`.claude/` instructions. The agent definition is in the merged config
(loaded via `OPENCODE_CONFIG` and `$HOME` isolation, see 7.5), in a
position that repo instructions can't override.

### 6.9 Fusion contract (D2)

When `fusion: true`, the synthesis pass operates on a fixed contract:

- **Labels**: each individual review is labeled `<model> :: <prompt>` in
  the fusion input
- **Size limits**: 50k chars per review, 200k total
- **Injection protection**: code blocks attempting to override instructions
  are stripped before the fusion input
- **Tool access**: fusion runs with no tools enabled (pure synthesis)
- **Cost accounting**: fusion cost and tokens are included in the action's
  `cost`/`tokens` outputs

### 6.10 Partial results (D3)

The action **posts what's available** when some reviews fail:

- Individual results that succeed are posted
- If `fusion: true` and fusion succeeds, the fusion output is posted
- If fusion fails, individual results are posted with a note about the
  fusion failure
- Failures are logged to the Action output
- `fail-on-error` (default `false`) controls exit code: `true` means
  exit non-zero if any review failed

### 6.11 Debug output as workflow artifact (with redaction)

When `debug: true`, the action captures the full `opencode run` output
(JSONL event stream and stderr) to a temp file per invocation, gzips them,
and uploads the archive as a workflow artifact.

Before upload, the action **redacts known patterns** (`sk-ant-*`, `sk-*`,
`ghp_*`, `Bearer ...`). The user accepts the residual risk that redaction
is heuristic. Debug is **opt-in only**.

### 6.12 Non-PR event destination (D1)

When the action runs on an event without a PR (push to default branch,
`workflow_dispatch`), the result is published as a **check run** rather
than a comment. The check run is named `ai-review` and the summary contains
the review. Downstream workflows can gate on it.

## 7. Action Interface

### 7.1 Composite step: `setup-opencode`

| Input | Default | Description |
|---|---|---|
| `version` | `1.18.4` | OpenCode version to install. The step fails if it can't install exactly this version. |
| `checksum` | *(required)* | SHA-256 of the OpenCode installer. The step verifies the installer before running it. |
| `install-dir` | `~/.opencode` | Where to place the `opencode` binary. |

The step downloads the OpenCode installer from a pinned URL, verifies the
checksum, and runs it. The `opencode` binary ends up on `PATH` for the
rest of the workflow.

Sample workflows use `@<sha>` for the action reference, not `@v1`. The
README maintains a table of vetted versions and their checksums.

### 7.2 `run-reviews` inputs

| Input | Default | Description |
|---|---|---|
| `model` | `anthropic/claude-sonnet-4.6` | Single model (provider/model). |
| `models` | *(empty)* | Comma-separated list for multi-model runs. |
| `prompts` | *(required)* | Comma-separated prompt sources with `file:` or `text:` prefix. See 7.4. |
| `opencode-config` | *(none)* | Path to a user-provided `opencode.json`/`.jsonc`. Merged into the action's config. |
| `permission` | *(see 6.1)* | JSON string for the `permission` block. |
| `opencode-version` | `1.18.4` | Version assertion. The action fails fast if the installed binary doesn't match. |
| `timeout-minutes` | `30` | Per-call timeout. |
| `fusion` | `false` | Run a synthesis pass (see 6.9). |
| `fusion-model` | *(first model)* | Single model for fusion. |
| `fail-on-error` | `false` | Exit non-zero if any review failed. |
| `debug` | `false` | Capture full `opencode run` output, redact, upload as artifact. |

There is intentionally no `target` input. The model decides what to review
based on the context injected into the agent definition (6.6).

### 7.3 `run-reviews` outputs

| Output | Description |
|---|---|
| `review` | Full review text (last model/prompt in stable lexical order, or fusion result). |
| `models-used` | Comma-separated models that completed successfully. |
| `cost` | Total cost in USD (sum across all calls including fusion). |
| `cost-by-model` | JSON object `{ "provider/model": <usd>, ... }`. |
| `tokens` | Total `{"input": <n>, "output": <n>}`. |
| `tokens-by-model` | JSON object `{ "provider/model": { "input": <n>, "output": <n> }, ... }`. |

### 7.4 `post-comment` and `post-check-run` steps

The second step publishes the result. The destination depends on the event:

- **`pull_request`** → posts a PR comment (`post-comment` step)
- **`push` to default branch, `workflow_dispatch`** → creates a check run
  (`post-check-run` step)

The action exposes the relevant step based on the event. Both share the
`comment-url` / `check-run-url` output.

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Token with `pull-requests: write` (for comments) or `checks: write` (for check runs). |
| `post` | `true` | Set `false` to skip publishing (useful for `workflow_dispatch` runs that consume outputs only). |
| `max-comment-chars` | `65000` | Truncate the body if it exceeds this. |

| Output | Description |
|---|---|
| `comment-url` | URL of the posted PR comment (pull_request events). |
| `check-run-url` | URL of the created check run (push/workflow_dispatch events). |

### 7.5 Prompt composition

The agent receives a **task prompt** composed from the user-provided input.
The action's privileged instructions live in the **agent definition** (6.8),
not in the prompt.

```
┌─────────────────────────────────────────┐
│  Agent Definition (action-owned,        │
│  lives in merged opencode.json)         │
│  · Privileged instructions              │
│  · Runtime context (event, refs, etc.)  │
│  · Output format rules                  │
│  · Severity legend                      │
│  · Behavior defaults                    │
└─────────────────────────────────────────┘
                  ↓
            agent invokes
                  ↓
┌─────────────────────────────────────────┐
│  Task Prompt (user-provided, what       │
│  the agent is asked to do)              │
│  · file:path/to/prompt.md               │
│  · text:inline content                  │
└─────────────────────────────────────────┘
                  ↓
            opencode run
```

**User input** is provided via `prompts:` as a comma-separated list of
`file:` or `text:` entries:

```yaml
prompts: |
  file:.github/prompts/code-review.md,
  text:Review this PR carefully, including the diff hunks,
  file:./extra.md
```

The action parses each entry prefix-first:

- `file:path` → reads the file (workspace-relative paths resolved from
  `GITHUB_WORKSPACE`, absolute paths used directly)
- `text:...` → uses the literal text that follows

**Build prompt step pattern** (recommended for non-trivial prompts):

```yaml
- name: Build prompt
  run: |
    {
      echo "# Code Review"
      echo ""
      echo "Review the changes this PR represents."
      echo "Be specific. Cite files and line numbers."
    } > /tmp/prompt.md
- uses: jander99/ai-review-action@v1
  with:
    prompts: file:/tmp/prompt.md
```

### 7.6 The `opencode.json` builder

The action builds the merged config at runtime. The flow:

1. **Cleanup** — delete any `opencode.json` / `opencode.jsonc` from the
   working directory (6.7)
2. **Read user config** — from `opencode-config:` input if provided
3. **Rebase paths** — paths in the user config (`{file:...}`, plugin paths,
   MCP `cwd`) are resolved relative to the user config's source directory
4. **Merge action-required settings** — these always win on conflict:
   - `permission` (default: explicit per-tool block from 6.1)
   - `agent` (the action's privileged instructions, 6.8)
   - `model` (from `model`/`models` inputs)
   - `provider` entries for the built-in custom providers (MiniMax, Kimi,
     AWS Bedrock, Google Vertex — see 7.7)
5. **Write to `$RUNNER_TEMP/opencode.json`** — the merged config location
6. **Set `HOME` to a temp dir** — isolates from any
   `~/.config/opencode/opencode.json` on the runner (relevant for
   self-hosted runners with preconfigured global config)
7. **Point OpenCode at it via `OPENCODE_CONFIG`** — the merged config is
   the only one OpenCode reads
8. **Validate** — against the `$schema` URL it declares. Field errors and
   version mismatches fail fast with a clear message before any model call.

### 7.7 Built-in provider registry

The action ships with built-in entries for the following custom providers
(native providers — Anthropic, OpenAI, Google Gemini, GitHub Copilot via
OpenCode — are detected automatically from env vars):

| Provider | npm package | Env var | Config |
|---|---|---|---|
| MiniMax | `@ai-sdk/openai-compatible` | `MINIMAX_API_KEY` | `baseURL: https://api.minimax.io/v1` |
| Kimi / Moonshot | `@ai-sdk/openai-compatible` | `KIMI_API_KEY` (or `MOONSHOT_API_KEY`) | `baseURL: https://api.moonshot.ai/v1` |
| AWS Bedrock | `@ai-sdk/amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK` (or AWS creds) | `region: us-east-1` (configurable) |
| Google Vertex | `@ai-sdk/google-vertex-anthropic` | `GOOGLE_APPLICATION_CREDENTIALS` | `project`, `region` |

Other providers must be fully declared in the user-provided config (via
`opencode-config:`).

### 7.8 Checkout requirements

The action asserts the checkout is suitable for git-based review. The
workflow must:

- Use `actions/checkout@v6`
- Pass `fetch-depth: 0` (full history)
- Ensure `origin/$BASE_REF` exists when the event has a base ref

The action fails fast before any model call if:

- `git rev-parse --verify origin/$BASE_REF` fails
- The working tree is not a git repository
- The `HEAD` commit is not reachable

The error message includes the exact command the user can run to diagnose.

## 8. OpenCode Runtime Contract

The action shells out to
`opencode run <prompt> --model <provider/model> --format json` and parses
the JSONL output.

| Surface | Behavior |
|---|---|
| Prompt | Positional argument. Task prompt from `prompts:`. |
| Agent | Loaded from the merged config (privileged instructions). |
| Model | `--model provider/model` flag, one invocation per model × prompt. |
| Format | `--format json` emits JSONL events. Verified in 1.18.4 — `step_finish` arrives with full `tokens` and `cost`. |
| Config | `$RUNNER_TEMP/opencode.json` via `OPENCODE_CONFIG` env var. Built by the action (7.6). |
| HOME | Set to a temp dir to isolate from `$HOME/.config/opencode/opencode.json`. |
| Env vars | Per-provider API keys (see §9). |
| Skills | Auto-loaded from `.claude/skills/`, `.opencode/skills/`, `.agents/skills/`. |
| MCPs | Declared in the merged config's `mcp` section, auto-spawned. |
| Plugins | Declared in the merged config's `plugin` field. |
| Permissions | Flat shape only. Default per-tool set from 6.1. |

### 8.1 Provider shapes in the merged config

**Native provider** (Anthropic, OpenAI, Google Gemini, GitHub Copilot via
OpenCode) — no action-injected entry needed; OpenCode detects from env vars.

**MiniMax / Kimi** (injected by the action):

```json
{
  "provider": {
    "minimax": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.minimax.io/v1",
        "apiKey": "{env:MINIMAX_API_KEY}"
      },
      "models": {
        "minimax-m3": { "name": "MiniMax-M3" }
      }
    }
  }
}
```

**AWS Bedrock** (injected):

```json
{
  "provider": {
    "amazon-bedrock": {
      "options": {
        "region": "us-east-1"
      }
    }
  }
}
```

**Google Vertex** (injected):

```json
{
  "provider": {
    "google-vertex-anthropic": {
      "options": {
        "project": "<project-id>",
        "region": "us-central1"
      }
    }
  }
}
```

### 8.2 MCP server shape

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer {env:GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Auto-spawned on `opencode run`. The action does not speak MCP itself.

## 9. Authentication

The action never sees an API key. The workflow injects env vars; the merged
config interpolates via `{env:VAR}`.

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| GitHub Copilot (via OpenCode) | `GITHUB_TOKEN` (requires Copilot permission) |
| AWS Bedrock | `AWS_BEARER_TOKEN_BEDROCK` or AWS creds |
| Google Vertex | `GOOGLE_APPLICATION_CREDENTIALS` |
| MiniMax | `MINIMAX_API_KEY` |
| Kimi / Moonshot | `KIMI_API_KEY` (or `MOONSHOT_API_KEY`) |
| Custom | `{env:USER_DEFINED_VAR}` per provider config |

**Precedence**: env vars > stored auth.json > `.env` files. Fresh GitHub
Actions runners have no stored auth, so env vars always win.

## 10. Safety Model

There is no app-level sandbox. The trust boundary is the workflow author.

**What the action does for safety**:

- **Deletes on-disk `opencode.json`** before running (6.7) — neutralizes
  PR-controlled config injection
- **Builds the agent definition** with privileged instructions (6.8) —
  repo instructions can't override
- **Generates explicit per-tool permissions** (6.1) — read-only by
  construction, edits require human-in-the-loop
- **Isolates merged config** via `$RUNNER_TEMP` + `HOME` redirect (7.6) —
  global config can't override
- **Validates merged config** against `$schema` before any model call
- **Surfaces cost and tokens** so token abuse is visible
- **Redacts known secret patterns** in debug artifacts
- **Version-asserts OpenCode** — fails fast if the installed binary doesn't
  match the pinned version

**What the workflow does for safety**:

- `permissions: contents: read` (and `pull-requests: write` only for posting)
- Read-only `GITHUB_TOKEN`
- Explicit denials (`id-token: none`, `packages: none`, etc.)
- Only installs skills from trusted sources (`npx skills add <trusted-repo>`)
- Uses the composite `setup-opencode` step with checksum verification

**Known limitations** (documented, not mitigated):

- Untrusted PR code is still on disk and the model can read it. AGENTS.md
  and `.claude/` instructions in the repo can still influence the model —
  the agent definition is privileged, but the model sees everything in the
  context window.
- A model with `bash: allow` can read provider API keys from env and
  exfiltrate them. This is an accepted risk of running an agent on
  untrusted code.
- The OpenCode permission engine is too coarse for sub-command allow-lists.
  The action cannot restrict `bash` to specific commands.

**What we deliberately do NOT do**:

- Verify the model "actually did the review." The agent definition states
  the task and the context; the model decides what to review.
- Pretend the model is contained when it's not.
- Hide the model's tool surface from the user.

## 11. Sample Workflows

### 11.1 Quickstart (with composite setup step)

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: <sha256>

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:.github/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 11.2 Default permissions (no explicit `permissions:` block)

The action generates explicit per-tool permissions (6.1). Without a
`permissions:` block, the runner's default `GITHUB_TOKEN` applies.

```yaml
steps:
  - uses: actions/checkout@v6
    with: { fetch-depth: 0 }

  - uses: jander99/ai-review-action/setup-opencode@v1
    with:
      version: 1.18.4
      checksum: <sha256>

  - uses: jander99/ai-review-action@v1
    with:
      model: anthropic/claude-sonnet-4.6
      prompts: file:.github/prompts/code-review.md
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Token scope: depends on the runner's repo/org default. May or may not be
able to post comments.

### 11.3 Multi-model with fusion

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: <sha256>

      - uses: jander99/ai-review-action@v1
        with:
          models: "anthropic/claude-sonnet-4.6, openai/gpt-4o"
          prompts: "file:.github/prompts/code-review.md, file:.github/prompts/security-review.md"
          fusion: true
          fusion-model: anthropic/claude-sonnet-4.6
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY:     ${{ secrets.OPENAI_API_KEY }}
```

### 11.4 User-provided `opencode.json` (merged with required settings)

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: <sha256>

      - uses: jander99/ai-review-action@v1
        with:
          opencode-config: ./opencode.json
          prompts: file:.github/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 11.5 With skills and MCPs

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: <sha256>

      - name: Install skills
        run: npx -y skills@1 add vercel-labs/agent-skills --agent opencode --yes

      - uses: jander99/ai-review-action@v1
        with:
          models: "anthropic/claude-sonnet-4.6"
          prompts: file:.github/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 11.6 Custom provider (MiniMax)

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: <sha256>

      - uses: jander99/ai-review-action@v1
        with:
          model: minimax/minimax-m3
          prompts: file:.github/prompts/code-review.md
        env:
          MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

### 11.7 Debug mode

```yaml
steps:
  - uses: actions/checkout@v6
    with: { fetch-depth: 0 }

  - uses: jander99/ai-review-action/setup-opencode@v1
    with:
      version: 1.18.4
      checksum: <sha256>

  - uses: jander99/ai-review-action@v1
    with:
      model: anthropic/claude-sonnet-4.6
      prompts: file:.github/prompts/code-review.md
      debug: true
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
# On completion, an `ai-review-debug` artifact containing the gzipped,
# redacted JSONL event streams is attached to the workflow run.
```

### 11.8 Push to default branch (check run, not comment)

```yaml
on:
  push:
    branches: [main]

permissions:
  contents: read
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: <sha256>

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:.github/prompts/repo-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
# Result published as a check run named `ai-review`. No PR to comment on.
```

## 12. Future Work

### 12.1 OpenCode-as-tests on Actions

A separate marketplace action that uses the same runtime contract but is
shaped for testing OpenCode itself or testing user code with OpenCode:
matrix of providers × models, posts results as artifacts instead of
comments or check runs.

### 12.2 Skill registry

A curated registry of review-relevant skills (e.g., `code-review`,
`security-review`, `dependency-review`) discoverable via `npx skills find`.

### 12.3 Plugin ecosystem

OpenCode's plugin model is open. Review-specific plugins (LSP-based code
analysis, formatter enforcement, license checks) can be composed without
forking the action.

### 12.4 Multi-agent reviews

OpenCode sessions support multi-turn. A future iteration could orchestrate
a multi-agent review (one agent drafts, another critiques, a third
synthesizes) entirely in `opencode` without the action owning the loop.

### 12.5 Fork-PR behavior

Fork pull requests receive no repository secrets, so provider API keys are
empty and every `opencode run` would fail with an auth error. The intended
behavior (skip silently, fail with a clear message, or support a
public-model fallback) is an open design discussion.

### 12.6 Contract tests for "verified" ABI

Every "verified in 1.18.4" claim in this document is the action's brittle
ABI. A pinned test fixture (CLI invocation → expected JSONL shape) per
claim catches version drift. Implementation work, not design.

## 13. References

- OpenCode CLI: https://opencode.ai/docs
- OpenCode `opencode.json` schema: https://opencode.ai/config.json
- MCP server config: https://opencode.ai/docs/mcp-servers
- Provider list: https://opencode.ai/docs/providers
- `npx skills` (Vercel Labs): https://github.com/vercel-labs/skills
- Vercel AI SDK: https://ai-sdk.dev/v7/docs
- Current prototype: see `README.md` and `action.yml`
