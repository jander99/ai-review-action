# AI Review Action — Design Vision

> Status: design / pre-implementation. The repo contains a Copilot-CLI-based
> prototype (see `README.md`). This document describes the design of the
> reimagined action built on the OpenCode CLI.

## 1. Problem

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

## 2. Goal

An action that:

- **Shells out to the OpenCode CLI** as the runtime harness
- **Accepts API keys per provider** via env vars (no Copilot PAT)
- **Lets the workflow own the runtime**: skills, MCPs, plugins, providers —
  declared in `opencode.json` or composed in workflow steps
- **Owns the parts only it can own**: the system prompt, the composed
  `opencode.json` with required settings injected, result aggregation, and
  comment posting
- **Surfaces cost and tokens** in outputs for every result
- **Supports multi-model, multi-prompt, and fusion** as optional orchestrations

## 3. Architecture

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
│  · permissions (bash: allow, edit: deny, read: allow, ...)     │
└─────────────────────────────────────────────────────────────────┘
```

The action has two steps:

1. **`run-reviews`** — builds the final `opencode.json` (merging any
   user-provided config with required settings), composes the prompt,
   resolves the target, calls `opencode run`, parses `--format json`,
   aggregates results.
2. **`post-comment`** — posts the final review as a PR comment.

## 4. Key Decisions

### 4.1 `bash: allow` is baked into the generated config

The prompts tell the model to run `git log`, `git diff`, etc. The OpenCode
permission engine is **all-or-nothing at the tool level** — fine-grained
sub-command allow-lists do not work (verified: the nested
`{ "git *": "allow", "*": "deny" }` shape denies bash entirely).

The action's generated `opencode.json` always includes
`permission: { bash: "allow" }` when the resolved target is `diff`, because
the model fetches the diff itself via tool calls. Safety is the **GitHub
token scope** in the workflow (`permissions: contents: read` + read-only
`GITHUB_TOKEN`), not an app-level sandbox.

### 4.2 API keys via env vars, non-interactive

`opencode run` reads per-provider env vars at startup. `opencode auth login`
is interactive (requires a TTY) and has no `--api-key` flag. The only
CI-safe path is env vars.

The action never handles auth itself. The workflow injects env vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY`,
`AWS_BEARER_TOKEN_BEDROCK`, etc.) and `opencode.json` interpolates them via
`{env:VAR}`.

Precedence: env vars > stored credentials (`~/.local/share/opencode/auth.json`)
> `.env` files. A fresh GitHub Actions runner has no stored credentials, so
env vars just work.

### 4.3 Multi-model / multi-prompt / fusion are optional

All three are first-class inputs but all default off:

- **Single model, single prompt** is the default (simplest, cheapest)
- **`models:`** enables multi-model runs (same prompts, multiple models)
- **`prompts:`** can be a list (same model, multiple prompts)
- **`fusion:`** enables a synthesis pass combining all individual results

The action cross-products `models × prompts` and calls `opencode run` once
per combination. Multi-prompt to the same model is a valid cross-cut.

### 4.4 Cost and tokens surfaced in outputs

`opencode run --format json` emits `step_finish` events with `tokens` and
`cost` per call (verified in OpenCode 1.18.4 — the earlier truncation bug
is fixed). The action parses JSONL, aggregates, and surfaces cost and token
usage in outputs (see 5.2).

### 4.5 The runtime is the workflow's responsibility — except the config

The workflow installs OpenCode, installs skills, and (optionally) writes an
`opencode.json`. The action **does** build the final config, because some
settings are required for the action to function (see 5.5).

| Concern | Prototype (Copilot CLI) | Reimagined (OpenCode) |
|---|---|---|
| Install runtime | `action.yml` inline | workflow step |
| Install skills | not supported | `npx skills add` |
| `opencode.json` | not supported | workflow (optional) + action builder merges required settings |
| Install plugins | not supported | `opencode.json` plugin field |
| Inject auth | `copilot-token` input | env vars |
| Gatekeep git | `--allow-tool=shell(git:*)` | `contents: read` + read-only token |

### 4.6 The model fetches the diff itself

The action does **not** pre-compute the diff and inline it into the prompt —
`git diff` as a string does not scale, and OpenCode manages context and
compaction across however many turns the diff requires. The system prompt
(5.4) steers the model: it knows it is running in a GitHub Actions runner
with a checked-out repo, reviewing a pull request, and that it should run
`git diff origin/$BASE_REF...HEAD` to see the changes. For `target: full`,
it is steered toward file reads (`read`, `glob`, `grep`).

### 4.7 Debug output as workflow artifact

When `debug: true`, the action captures the full `opencode run` output
(JSONL event stream and stderr) to a temp file per invocation, gzips them,
and uploads the archive as a workflow artifact. This is the troubleshooting
surface — raw model/tool events are preserved without polluting the Action
log.

## 5. Action Interface

### 5.1 `run-reviews` inputs

| Input | Default | Description |
|---|---|---|
| `model` | `anthropic/claude-sonnet-4.6` | Single model (provider/model). Used when `models` is empty. |
| `models` | *(empty)* | Comma-separated list for multi-model runs. |
| `prompts` | *(required)* | Comma-separated prompt sources: workspace-relative file paths or inline strings. No built-in prompts ship. |
| `target` | *(auto-resolve)* | `diff` \| `full`. Auto-resolves to `diff` on `pull_request`, `full` on push to the default branch. On the default branch the same prompt runs against the full repo. |
| `opencode-config` | *(none)* | Path to a user-provided `opencode.json`/`.jsonc`. Merged into the generated config (5.5); required action settings win on conflict. |
| `permission` | `{"bash":"allow"}` | JSON string for the `permission` block in the generated config. |
| `opencode-version` | `1.18.4` | Pinned OpenCode version (match the verified contract). |
| `timeout-minutes` | `30` | Per-call timeout. |
| `fusion` | `false` | Run a synthesis pass combining all individual results. |
| `fusion-model` | *(first model)* | Single model for fusion. Must be a single model name, not a list. |
| `fail-on-error` | `false` | Exit non-zero if all reviews fail. |
| `debug` | `false` | Capture full `opencode run` output to temp files, gzip, and upload as a workflow artifact. |

### 5.2 `run-reviews` outputs

| Output | Description |
|---|---|
| `review` | Full review text (last model/prompt or fusion result). |
| `comment-url` | URL of the posted PR comment. |
| `models-used` | Comma-separated models that completed successfully. |
| `cost` | Total cost in USD (sum across all `opencode run` calls). |
| `cost-by-model` | JSON object `{ "provider/model": <usd>, ... }`. |
| `tokens` | Total `{"input": <n>, "output": <n>}`. |
| `tokens-by-model` | JSON object `{ "provider/model": { "input": <n>, "output": <n> }, ... }`. |

### 5.3 `post-comment` step

Unchanged from the prototype.

### 5.4 Prompt Composition

The action composes prompts in two layers — a **baked-in system prompt**
the action owns and a **user input** the workflow provides. The model never
sees the user's input in isolation; it sees the composed prompt.

```
┌─────────────────────────────────────────┐
│  System Prompt (action-owned, fixed)    │
│  · Environment description              │
│  · Context hints (target, refs)         │
│  · Output format rules                  │
│  · Severity legend                      │
│  · Boilerplate / defaults               │
└─────────────────────────────────────────┘
                  +
┌─────────────────────────────────────────┐
│  User Input (user-provided)             │
│  · File path in repo, or                │
│  · String in action input               │
└─────────────────────────────────────────┘
                  ↓
        [ Composed Prompt ]
                  ↓
            opencode run
```

**System prompt** (action-owned, not overridable). It is **parameterized**
with runtime context the action detects from `github.event_name`,
`github.event.*`, and the resolved `target`, and it contains:

- **Environment description**: running in a GitHub Actions runner with the
  repository checked out, invoked through OpenCode, with whatever MCP
  tools / plugins / skills the runtime provides.
- **Context hints** that steer the model toward the right tool calls:
  - Pull-request context (`target: diff`): "you are reviewing a pull
    request; use `git diff origin/$BASE_REF...HEAD` to see the changes
    this PR represents."
  - Full-code context (`target: full`): "you are reviewing the repository
    as a whole; use file reads (`read`, `glob`, `grep`) to inspect the
    codebase."
- **Output format**: markdown structure, severity legend (🔴 critical /
  🟡 suggestion / 🟢 minor), length guidance, no-preamble rule.
- **Behavior defaults**: when no issues are found, say so explicitly
  rather than inventing feedback.

The system prompt is exposed via the `AI_REVIEW_SYSTEM_PROMPT` environment
variable for advanced users to inspect before invoking the action.

**User input** (user-provided, via `prompts:`):

- A workspace-relative path (e.g., `.github/prompts/code-review.md`) — the
  action reads the file at runtime
- An inline string in the action input — the action uses it directly
- Comma-separated lists for multi-prompt runs

**Build prompt step pattern** (recommended): the workflow composes the
substantive prompt content in a pre-step (read files, generate context,
substitute variables), then passes the resulting path to the action.

```yaml
- name: Build prompt
  run: |
    {
      echo "# Code Review"
      echo ""
      echo "Review the changes in this PR."
      # ... compose content ...
    } > /tmp/prompt.md
- uses: jander99/ai-review-action@v1
  with:
    prompts: /tmp/prompt.md
```

The action's `prompts:` input accepts both repo-relative paths and absolute
paths in the runner filesystem.

### 5.5 The `opencode.json` builder

Users should not need to know which settings the action requires to
function. The action **builds the final `opencode.json` at runtime**:

1. **Start from the user config**, if provided — the `opencode-config:`
   input, or an `opencode.json`/`.jsonc` at the repo root. JSONC (comments)
   is accepted.
2. **Merge action-required settings on top**. These always win on conflict:
   - `permission` (from the `permission` input — `bash: allow` by default,
     required for the model to fetch the diff)
   - `model` (from `model`/`models` inputs, for the current invocation)
   - `provider` entries with `{env:VAR}` interpolation for any provider the
     action was configured to use
3. **Preserve everything else from the user config**: `mcp` servers,
   `plugin` lists, `watcher`, `tool_output`, `agent`, etc.
4. **Write the merged config** to `$RUNNER_TEMP/opencode.json` and point
   OpenCode at it via the `OPENCODE_CONFIG` env var. The user's file is
   never mutated.
5. **Validate the merged config** against the `$schema` URL it declares.
   Field errors and version mismatches fail fast with a clear message
   before any model call is made.

Because required settings always win, a user config cannot silently break
the diff flow (e.g., a user-supplied `bash: deny` is overridden by the
action's `bash: allow` in diff mode). Users who deliberately want a
tighter runtime can set the `permission` input, which *is* the required
setting.

## 6. OpenCode Runtime Contract

The action shells out to
`opencode run <prompt> --model <provider/model> --format json` and parses
the JSONL output. The contract is:

| Surface | Behavior |
|---|---|
| Prompt | Positional argument (or stdin). Composed system prompt + user input. |
| Model | `--model provider/model` flag, one invocation per model × prompt. |
| Format | `--format json` emits JSONL events. **Verified** in 1.18.4 — `step_finish` arrives with full `tokens` and `cost`. |
| Config | `$RUNNER_TEMP/opencode.json` via `OPENCODE_CONFIG` env var, built by the action (5.5). |
| Env vars | Per-provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, etc.). |
| Skills | Auto-loaded from `.claude/skills/`, `.opencode/skills/`, `.agents/skills/`. |
| MCPs | Declared in the merged `opencode.json` `mcp` section, auto-spawned on `opencode run`. |
| Plugins | Declared in the merged `opencode.json` `plugin` field. |
| Permissions | Flat shape only: `{ "bash": "allow" }`. Nested shapes (`{ "git *": "allow" }`) are rejected by the engine — verified. |

### 6.1 Provider shapes in `opencode.json`

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

### 6.2 MCP server shape in `opencode.json`

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

## 7. Authentication

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

## 8. Safety Model

There is no app-level sandbox. The trust boundary is the workflow author.

**What the action does for safety**:

- Pins `opencode-version` to a verified release (1.18.4 at time of writing)
- Controls the required settings in the merged `opencode.json` (5.5) so a
  user config cannot silently change the action's trust assumptions
- Surfaces cost and tokens so token abuse is visible
- Ships the system prompt, which defines the model's standing instructions

**What the workflow does for safety**:

- `permissions: contents: read` in the workflow YAML
- Read-only `GITHUB_TOKEN` (the default for `${{ github.token }}` if no
  `permissions:` block asks for more)
- Explicit denials (`id-token: none`, `packages: none`, etc.)
- MCPs that need write access (e.g., `github_delete_file`) require the
  workflow author to opt in

**What we deliberately do NOT do**:

- App-level sandboxing of the model (the OpenCode permission engine is too
  coarse and the cost outweighs the benefit)
- Verify the model "actually did the review." The system prompt states the
  task and the context; a model that cannot reason its way to `git diff`
  from that hint is the wrong model for the job
- Pretend the model is contained when it's not
- Hide the model's tool surface from the user

## 9. Sample Workflows

### 9.1 Single model, single prompt

```yaml
- uses: jander99/ai-review-action@v1
  with:
    model: anthropic/claude-sonnet-4.6
    prompts: .github/prompts/code-review.md
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 9.2 Multi-model with fusion

```yaml
- uses: jander99/ai-review-action@v1
  with:
    models: "anthropic/claude-sonnet-4.6, openai/gpt-4o"
    prompts: ".github/prompts/code-review.md, .github/prompts/security-review.md"
    fusion: true
    fusion-model: anthropic/claude-sonnet-4.6
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    OPENAI_API_KEY:     ${{ secrets.OPENAI_API_KEY }}
```

### 9.3 User-provided `opencode.json` (merged with required settings)

```yaml
- uses: jander99/ai-review-action@v1
  with:
    opencode-config: ./opencode.json
    prompts: .github/prompts/code-review.md
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 9.4 With skills and MCPs

```yaml
steps:
  - uses: actions/checkout@v6
    with: { fetch-depth: 0 }

  - name: Install skills
    run: npx -y skills@1 add vercel-labs/agent-skills --agent opencode --yes

  - name: Install OpenCode
    run: curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.4

  - uses: jander99/ai-review-action@v1
    with:
      models: "anthropic/claude-sonnet-4.6"
      prompts: .github/prompts/code-review.md
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 9.5 Debug mode

```yaml
- uses: jander99/ai-review-action@v1
  with:
    model: anthropic/claude-sonnet-4.6
    prompts: .github/prompts/code-review.md
    debug: true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
# On completion, an `ai-review-debug` artifact containing the gzipped
# JSONL event streams is attached to the workflow run.
```

## 10. Future Work

### 10.1 OpenCode-as-tests on Actions

A separate marketplace action that uses the same runtime contract but is
shaped for testing OpenCode itself or testing user code with OpenCode:
matrix of providers × models, posts results as artifacts instead of PR
comments.

### 10.2 Skill registry

A curated registry of review-relevant skills (e.g., `code-review`,
`security-review`, `dependency-review`) discoverable via `npx skills find`.

### 10.3 Plugin ecosystem

OpenCode's plugin model is open. Review-specific plugins (LSP-based code
analysis, formatter enforcement, license checks) can be composed without
forking the action.

### 10.4 Multi-agent reviews

OpenCode sessions support multi-turn. A future iteration could orchestrate
a multi-agent review (one agent drafts, another critiques, a third
synthesizes) entirely in `opencode` without the action owning the loop.

### 10.5 Fork-PR behavior

Fork pull requests receive no repository secrets, so provider API keys are
empty and every `opencode run` would fail with an auth error. The intended
behavior (skip silently, fail with a clear message, or support a
public-model fallback) is an open design discussion.

## 11. References

- OpenCode CLI: https://opencode.ai/docs
- OpenCode `opencode.json` schema: https://opencode.ai/config.json
- MCP server config: https://opencode.ai/docs/mcp-servers
- Provider list: https://opencode.ai/docs/providers
- `npx skills` (Vercel Labs): https://github.com/vercel-labs/skills
- Vercel AI SDK: https://ai-sdk.dev/v7/docs
- Current prototype: see `README.md` and `action.yml`
