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
- Owns the parts only it can own: the **context-aware system prompt**, the
  **composed `opencode.json` with required settings injected**, result
  aggregation, and comment posting
- Surfaces **cost and tokens** in outputs for every result
- Supports **multi-model, multi-prompt, and fusion** as optional orchestrations
- **Never materializes a diff**. The model decides what to review.

## 2. Prerequisites

The action shells out to `opencode run`. The workflow is responsible for
preparing the runner.

**Runner**:

- Linux (`ubuntu-latest` or self-hosted). macOS and Windows are not supported.

**Required binaries** on `PATH`:

- `curl` (workflow install step)
- `npx` (Node 22+, workflow install step)
- `git` (the model uses it to determine what to review)
- `bash`
- `opencode` (workflow installs; the action version-asserts)

**Required environment**:

- Provider API keys as env vars (e.g. `ANTHROPIC_API_KEY`). The action never
  reads them directly; `opencode.json` interpolates via `{env:VAR}`.
- `GITHUB_TOKEN` (default permissions suffice for `pull_request` reviews).

**Required checkout** (strict, the action asserts):

- `actions/checkout@v6` with `fetch-depth: 0`
- The base ref must be fetched — `origin/$BASE_REF` must exist before the
  action runs. The action fails fast with a clear error if it doesn't.

## 3. Quickstart

Minimal runnable example. Covers everything: checkout, install, run.

```yaml
name: AI Review
on:
  pull_request:

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }

      - name: Install OpenCode
        run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:.github/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The `prompt:` file tells the model what to do. The action injects the
runtime context (event, refs, branch) into the system prompt so the model
knows it is reviewing a pull request and can pull `git diff` itself.

## 4. Problem

The prototype in this repo is a thin wrapper around the **GitHub Copilot CLI**:

- Shells out to `copilot -p <prompt>` with a fine-grained PAT (`copilot-token`)
- Models are limited to whatever the user's GitHub Copilot subscription exposes
- Prompts are first-class inputs (`code-review`, `security-review`, etc.)
- Tool access is restricted to `shell(git:*)` via `--allow-tool`
- Multi-model runs and fusion are orchestrations the action owns

That coupling is the limitation. Three things are hard to express in the
prototype:

1. **API-key-only multi-provider**. No Claude-direct, no OpenAI-direct, no
   MiniMax, no Kimi — only what GitHub Copilot routes.
2. **User-composable runtime**. The action owns prompts, models, and tool
   access. A user wanting a custom MCP server, a specific CLI tool, or a
   plugin has to fork the action.
3. **Reproducible agent environments**. The runtime is whatever the runner
   happens to have. No pin, no cache, no reproducibility.

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Actions Workflow                     │
│                                                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │ Install OpenCode │  │ Install Skills  │  │ Write         │  │
│  │ (curl | bash)    │  │ (npx skills add) │  │ opencode.json │  │
│  │                  │  │                  │  │ (optional)    │  │
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘  │
│           │                    │                  │          │
│           └────────────────────┴──────────────────┘          │
│                                │                             │
│                                ▼                             │
│              ┌────────────────────────────────┐             │
│              │  jander99/ai-review-action@v1   │             │
│              │  ┌──────────────────────────┐  │             │
│              │  │ run-reviews              │  │             │
│              │  │  · build opencode.json   │  │             │
│              │  │  · inject context        │  │             │
│              │  │  · compose prompt        │  │             │
│              │  │  · opencode run × N      │  │             │
│              │  │  · aggregate + fusion    │  │             │
│              │  └──────────────────────────┘  │             │
│              │  post-comment                   │             │
│              └────────────────┬───────────────┘             │
│                               │                              │
│  Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.             │
│  Token:  GITHUB_TOKEN (read-only)                             │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼ shell: opencode run
┌─────────────────────────────────────────────────────────────────┐
│                       OpenCode Runtime                         │
│  · providers (anthropic, openai, minimax, kimi, ...)           │
│  · mcp servers (auto-spawned from opencode.json)               │
│  · plugins (loaded from opencode.json)                         │
│  · skills (auto-discovered from .claude/, .opencode/, .agents/)│
│  · permissions (read/glob/grep/list/webfetch allow;            │
│    edit/question/doom_loop ask; bash: allow)                   │
└─────────────────────────────────────────────────────────────────┘
```

The action has two steps:

1. **`run-reviews`** — builds the final `opencode.json` (merging any
   user-provided config with required settings), injects runtime context,
   composes the prompt, calls `opencode run`, parses `--format json`,
   aggregates results.
2. **`post-comment`** — posts the final review as a PR comment. Owns the
   `comment-url` output.

## 6. Key Decisions

### 6.1 Permission defaults are explicit per-tool

The OpenCode permission engine is **all-or-nothing at the tool level**: the
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

This makes reviews **read-only by construction** — the model can read files
and run shell, but every edit goes through a human-in-the-loop prompt.
Users can override the entire block via the `permission` input.

### 6.2 API keys via env vars, non-interactive

`opencode run` reads per-provider env vars at startup. `opencode auth login`
is interactive (TTY required) and has no `--api-key` flag. The only
CI-safe path is env vars.

The action never handles auth itself. The workflow injects env vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY`,
`AWS_BEARER_TOKEN_BEDROCK`, etc.) and `opencode.json` interpolates them via
`{env:VAR}`.

Precedence: env vars > stored credentials (`~/.local/share/opencode/auth.json`)
> `.env` files. A fresh GitHub Actions runner has no stored credentials, so
env vars just work.

### 6.3 Multi-model / multi-prompt / fusion are optional

All three are first-class inputs but all default off:

- **Single model, single prompt** is the default (simplest, cheapest)
- **`models:`** enables multi-model runs (same prompts, multiple models)
- **`prompts:`** can be a list (same model, multiple prompts)
- **`fusion:`** enables a synthesis pass combining all individual results

The action cross-products `models × prompts` and calls `opencode run` once
per combination. Results are aggregated in **stable lexical order** (prompts
first, then models) so the same inputs always produce the same output.

Multi-prompt to the same model is a valid cross-cut: the same model reviews
`code-review.md`, then `security-review.md`, in lexical order.

### 6.4 Cost and tokens surfaced in outputs

`opencode run --format json` emits `step_finish` events with `tokens` and
`cost` per call (verified in OpenCode 1.18.4 — the earlier truncation bug
is fixed). The action parses JSONL, aggregates, and surfaces cost and token
usage in outputs (see 7.2).

### 6.5 The runtime is the workflow's responsibility — except the config

The workflow installs OpenCode (a pinned version), installs skills, and
(optionally) writes an `opencode.json`. The action **does** build the final
config, because some settings are required for the action to function
(see 7.5).

`opencode-version` is a **version assertion**, not an installer. The action
fails fast if the installed binary doesn't match.

| Concern | Prototype (Copilot CLI) | Reimagined (OpenCode) |
|---|---|---|
| Install runtime | `action.yml` inline | workflow step (curl install) |
| Install skills | not supported | `npx skills add` |
| `opencode.json` | not supported | workflow (optional) + action builder merges required settings |
| Install plugins | not supported | `opencode.json` plugin field |
| Inject auth | `copilot-token` input | env vars |
| Permission model | `--allow-tool=shell(git:*)` | explicit per-tool allow/ask |
| Runtime pin | none | workflow pins, action asserts |

### 6.6 Context-aware prompts — the model decides what to review

The action does **not** materialize a diff. There is no `target` input, no
`diff` vs `full` mode, no auto-resolution. The model figures out what to
review based on the context the action injects.

The action pulls runtime context from `github.event_name`,
`github.event.*`, and the resolved refs, and **injects it into the system
prompt template**:

- `pull_request` event: `event_name`, `pr_number`, `base_ref`, `head_ref`,
  `base_sha`, `head_sha`, `repo`
- `push` event: `event_name`, `ref`, `before`, `after`, `repo`
- `workflow_dispatch`: `event_name`, `inputs`, `repo`

The system prompt template renders with these values. The model is then
told what context it is in and figures out what to review (typically
`git diff origin/$BASE_REF...HEAD` for a PR, or `git log $BEFORE..$AFTER`
for a push).

This is the entire reason `target` doesn't exist: the prompt + the model's
judgment cover both cases, and the action needs no special-casing per
event. A model that cannot reason its way to `git diff` from the context
is the wrong model for the job.

### 6.7 Debug output as workflow artifact (with redaction)

When `debug: true`, the action captures the full `opencode run` output
(JSONL event stream and stderr) to a temp file per invocation, gzips them,
and uploads the archive as a workflow artifact.

Before upload, the action **redacts known patterns** (e.g. `sk-ant-*`,
`sk-*`, `ghp_*`, anything matching `Bearer ...`). The user accepts the
residual risk that redaction is heuristic. Debug is **opt-in only**; the
default is `false`.

## 7. Action Interface

### 7.1 `run-reviews` inputs

| Input | Default | Description |
|---|---|---|
| `model` | `anthropic/claude-sonnet-4.6` | Single model (provider/model). Used when `models` is empty. |
| `models` | *(empty)* | Comma-separated list for multi-model runs. |
| `prompts` | *(required)* | Comma-separated prompt sources with `file:` or `text:` prefix. `file:path/to/prompt.md` reads a file (workspace-relative or absolute); `text:...` uses inline text. Mix freely. See 7.4. |
| `opencode-config` | *(none)* | Path to a user-provided `opencode.json`/`.jsonc`. Merged into the generated config (7.5); required action settings win on conflict. |
| `permission` | *(see 6.1)* | JSON string for the `permission` block. Defaults to the explicit per-tool block. |
| `opencode-version` | `1.18.4` | Version assertion. The action fails fast if the installed `opencode` doesn't match. |
| `timeout-minutes` | `30` | Per-call timeout. |
| `fusion` | `false` | Run a synthesis pass combining all individual results. |
| `fusion-model` | *(first model)* | Single model for fusion. |
| `fail-on-error` | `false` | Exit non-zero if all reviews fail. |
| `debug` | `false` | Capture full `opencode run` output, redact patterns, upload as a workflow artifact. |

There is intentionally no `target` input. The model decides what to review
based on the context injected into the system prompt (6.6).

### 7.2 `run-reviews` outputs

| Output | Description |
|---|---|
| `review` | Full review text (last model/prompt in stable lexical order, or fusion result). |
| `models-used` | Comma-separated models that completed successfully. |
| `cost` | Total cost in USD (sum across all `opencode run` calls). |
| `cost-by-model` | JSON object `{ "provider/model": <usd>, ... }`. |
| `tokens` | Total `{"input": <n>, "output": <n>}`. |
| `tokens-by-model` | JSON object `{ "provider/model": { "input": <n>, "output": <n> }, ... }`. |

### 7.3 `post-comment` step

Unchanged from the prototype. Owns the `comment-url` output.

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Token with `pull-requests: write` to post comments. |
| `post-comment` | `true` | Set `false` to skip posting (e.g., for `workflow_dispatch` runs). |
| `max-comment-chars` | `65000` | Truncate the body if it exceeds this. |

| Output | Description |
|---|---|
| `comment-url` | URL of the posted PR comment. |

### 7.4 Prompt Composition

The action composes the prompt the model receives from two layers — a
**context-aware system prompt** the action owns and a **user input** the
workflow provides.

```
┌─────────────────────────────────────────┐
│  System Prompt (action-owned, fixed)    │
│  · Environment description              │
│  · Runtime context (event, refs, etc.)  │
│  · Output format rules                  │
│  · Severity legend                      │
│  · Boilerplate / defaults               │
└─────────────────────────────────────────┘
                  +
┌─────────────────────────────────────────┐
│  User Input (user-provided)             │
│  · file:path/to/prompt.md               │
│  · text:inline content                  │
└─────────────────────────────────────────┘
                  ↓
        [ Composed Prompt ]
                  ↓
            opencode run
```

**System prompt** is **parameterized** with runtime context and contains:

- **Environment description**: GitHub Actions runner, OpenCode CLI, whatever
  MCP tools / plugins / skills the runtime provides.
- **Runtime context** — the action injects event-specific values:
  - `pull_request`: `event_name`, `pr_number`, `base_ref`, `head_ref`,
    `base_sha`, `head_sha`, `repo`
  - `push`: `event_name`, `ref`, `before`, `after`, `repo`
  - `workflow_dispatch`: `event_name`, `inputs`, `repo`
- **Output format**: markdown structure, severity legend (🔴 critical /
  🟡 suggestion / 🟢 minor), length guidance, no-preamble rule.
- **Behavior defaults**: when no issues are found, say so explicitly
  rather than inventing feedback.

**User input** is provided via the `prompts:` input as a comma-separated
list of `file:` or `text:` entries. Inline commas are safe because entries
carry explicit prefixes:

```yaml
prompts: |
  file:.github/prompts/code-review.md,
  text:Review this PR carefully, including the diff hunks,
  file:./extra.md
```

Whitespace around commas is tolerated. The action parses each entry
prefix-first:

- `file:path` → the action reads the file (workspace-relative paths
  resolved from `GITHUB_WORKSPACE`, absolute paths used directly)
- `text:...` → the action uses the literal text that follows

**Build prompt step pattern** (recommended for non-trivial prompts): the
workflow composes the substantive prompt content in a pre-step:

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

### 7.5 The `opencode.json` builder

Users should not need to know which settings the action requires to
function. The action **builds the final `opencode.json` at runtime**:

1. **Start from the user config**, if provided — the `opencode-config:`
   input, or an `opencode.json`/`.jsonc` at the repo root. JSONC (comments)
   is accepted.
2. **Merge action-required settings on top**. These always win on conflict:
   - `permission` (default: the explicit per-tool block from 6.1)
   - `model` (from `model`/`models` inputs, for the current invocation)
   - `provider` entries with `{env:VAR}` interpolation for built-in providers
3. **Preserve everything else from the user config**: `mcp` servers,
   `plugin` lists, `watcher`, `tool_output`, `agent`, etc.
4. **Write the merged config** to `$RUNNER_TEMP/opencode.json` and point
   OpenCode at it via the `OPENCODE_CONFIG` env var. The user's file is
   never mutated.
5. **Validate the merged config** against the `$schema` URL it declares.
   Field errors and version mismatches fail fast with a clear message
   before any model call is made.

Because required settings always win on conflict, a user config cannot
silently break the action's trust assumptions. Users who deliberately want
a different permission set use the `permission` input, which *is* the
required setting.

### 7.6 Checkout requirements

The action asserts the checkout is suitable for git-based review. The
workflow must:

- Use `actions/checkout@v6`
- Pass `fetch-depth: 0` (full history, not a shallow clone)
- Ensure `origin/$BASE_REF` exists when the event has a base ref

The action fails fast before any model call if:

- `git rev-parse --verify origin/$BASE_REF` fails
- The working tree is not a git repository
- The `HEAD` commit is not reachable

The error message includes the exact command the user can run to diagnose
the issue.

## 8. OpenCode Runtime Contract

The action shells out to
`opencode run <prompt> --model <provider/model> --format json` and parses
the JSONL output.

| Surface | Behavior |
|---|---|
| Prompt | Positional argument. Composed system prompt + user input. |
| Model | `--model provider/model` flag, one invocation per model × prompt. |
| Format | `--format json` emits JSONL events. Verified in 1.18.4 — `step_finish` arrives with full `tokens` and `cost`. |
| Config | `$RUNNER_TEMP/opencode.json` via `OPENCODE_CONFIG` env var, built by the action (7.5). |
| Env vars | Per-provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, etc.). |
| Skills | Auto-loaded from `.claude/skills/`, `.opencode/skills/`, `.agents/skills/`. |
| MCPs | Declared in the merged `opencode.json` `mcp` section, auto-spawned on `opencode run`. |
| Plugins | Declared in the merged `opencode.json` `plugin` field. |
| Permissions | Flat shape only. Default per-tool set from 6.1. Nested shapes (`{ "git *": "allow" }`) are rejected by the engine — verified. |

### 8.1 Provider shapes in `opencode.json`

**Native provider** (Anthropic):

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

**Custom OpenAI-compatible provider** (MiniMax, Kimi, DeepSeek, OpenRouter):

```json
{
  "provider": {
    "minimax": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "MiniMax",
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

**Anthropic-compatible provider** (Bedrock, Vertex, custom proxy):

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

Bedrock uses `AWS_BEARER_TOKEN_BEDROCK` (or AWS creds). Vertex Anthropic
uses `GOOGLE_APPLICATION_CREDENTIALS`. Custom proxies use `@ai-sdk/anthropic`
with a custom `baseURL` and `x-api-key` header (Anthropic-style auth).

### 8.2 MCP server shape in `opencode.json`

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

The action never sees an API key. The workflow injects them as env vars.
`opencode.json` interpolates via `{env:VAR}`.

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| GitHub Copilot (via OpenCode) | `GITHUB_TOKEN` (requires Copilot permission) |
| AWS Bedrock | `AWS_BEARER_TOKEN_BEDROCK` or AWS creds |
| Google Vertex | `GOOGLE_APPLICATION_CREDENTIALS` |
| Custom OpenAI-compatible | `{env:USER_DEFINED_VAR}` per provider config |
| MiniMax | `MINIMAX_API_KEY` |
| Kimi / Moonshot | `KIMI_API_KEY` (or `MOONSHOT_API_KEY`) |

**Precedence**: env vars > stored auth.json > `.env` files. Fresh GitHub
Actions runners have no stored auth, so env vars always win.

## 10. Safety Model

There is no app-level sandbox. The trust boundary is the workflow author.

**What the action does for safety**:

- Pins the implicit OpenCode version (1.18.4 verified); the action fails
  fast if the installed binary doesn't match
- Generates the `permission` block with all relevant tools explicitly set
  (read-only by construction; edits require human-in-the-loop)
- Validates the merged config against its `$schema` before any model call
- Surfaces cost and tokens so token abuse is visible
- Builds the context-aware system prompt that defines the model's standing
  instructions
- Redacts known secret patterns in debug artifacts

**What the workflow does for safety**:

- `permissions: contents: read` (and `pull-requests: write` only for posting)
- Read-only `GITHUB_TOKEN`
- Explicit denials (`id-token: none`, `packages: none`, etc.)
- MCPs that need write access require the workflow author to opt in

**Known limitations** (documented, not mitigated):

- Untrusted PR content (opencode.json, skills, AGENTS.md, local MCP
  commands) is loaded with provider API keys in scope. A model executing
  shell can read those env vars and exfiltrate them. This is an accepted
  risk of running an agent on untrusted code.
- The OpenCode permission engine is too coarse for sub-command allow-lists.
  The action cannot restrict `bash` to specific commands.

**What we deliberately do NOT do**:

- App-level sandboxing of the model
- Verify the model "actually did the review." The system prompt states the
  task and the context; the model decides what to review.
- Pretend the model is contained when it's not
- Hide the model's tool surface from the user

## 11. Sample Workflows

### 11.1 Default behavior — no explicit `permissions:` block

The action generates explicit per-tool permissions (6.1). Without a
`permissions:` block in the workflow, the runner's default `GITHUB_TOKEN`
permissions apply.

```yaml
steps:
  - uses: actions/checkout@v6
    with: { fetch-depth: 0 }

  - name: Install OpenCode
    run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

  - uses: jander99/ai-review-action@v1
    with:
      model: anthropic/claude-sonnet-4.6
      prompts: file:.github/prompts/code-review.md
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Token scope: depends on the runner's repo/org default. May or may not be
able to post comments. May grant more than the action needs.

### 11.2 Explicit minimal permissions

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

      - name: Install OpenCode
        run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:.github/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action's `post-comment` step fails fast if the token can't post.

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

      - name: Install OpenCode
        run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

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

      - name: Install OpenCode
        run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

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

      - name: Install OpenCode
        run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

      - name: Install skills
        run: npx -y skills@1 add vercel-labs/agent-skills --agent opencode --yes

      - uses: jander99/ai-review-action@v1
        with:
          models: "anthropic/claude-sonnet-4.6"
          prompts: file:.github/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 11.6 Internal text prompt with inline comma

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

      - name: Install OpenCode
        run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: "text:Review this PR thoroughly, including tests, docs, and config changes."
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 11.7 Debug mode

```yaml
steps:
  - uses: actions/checkout@v6
    with: { fetch-depth: 0 }

  - name: Install OpenCode
    run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

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

## 12. Future Work

### 12.1 OpenCode-as-tests on Actions

A separate marketplace action that uses the same runtime contract but is
shaped for testing OpenCode itself or testing user code with OpenCode:
matrix of providers × models, posts results as artifacts instead of PR
comments.

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

### 12.6 Default-branch push destination

When the action runs on a non-`pull_request` event (e.g., `push` to the
default branch), there is no PR to post a comment to. Possible
destinations: commit status, check run, issue, or skip posting entirely.

## 13. References

- OpenCode CLI: https://opencode.ai/docs
- OpenCode `opencode.json` schema: https://opencode.ai/config.json
- MCP server config: https://opencode.ai/docs/mcp-servers
- Provider list: https://opencode.ai/docs/providers
- `npx skills` (Vercel Labs): https://github.com/vercel-labs/skills
- Vercel AI SDK: https://ai-sdk.dev/v7/docs
- Current prototype: see `README.md` and `action.yml`
