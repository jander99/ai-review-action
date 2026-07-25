# AI Review Action v2 — Design Vision

> Status: vision / pre-implementation. The current action is the
> Copilot-CLI-based v1 (see `README.md`). This document describes the v2
> direction discussed and verified during the design phase.

## 1. Problem

The current action is a thin wrapper around the **GitHub Copilot CLI**:

- Shells out to `copilot -p <prompt>` with a fine-grained PAT (`copilot-token`)
- Models are limited to whatever the user's GitHub Copilot subscription exposes
- Prompts are first-class inputs (`code-review`, `security-review`, etc.)
- Tool access is restricted to `shell(git:*)` via `--allow-tool`
- Multi-model runs and fusion are orchestrations the action owns

That coupling is the limitation. Three things are hard to express today:

1. **API-key-only multi-provider**. No Claude-direct, no OpenAI-direct, no
   MiniMax, no Kimi — only what GitHub Copilot routes.
2. **User-composable runtime**. The action owns prompts, models, and tool
   access. A user wanting a custom MCP server, a specific CLI tool, or a
   plugin has to fork the action.
3. **Reproducible agent environments**. The action's runtime is whatever the
   runner happens to have. No pin, no cache, no reproducibility.

## 2. Goal

A v2 action that:

- **Shells out to the OpenCode CLI** as the runtime harness
- **Accepts API keys per provider** via env vars (no Copilot PAT)
- **Lets the workflow own the runtime**: skills, MCPs, plugins, providers,
  permissions — all declared in `opencode.json` (or whatever the user
  composes)
- **Surfaces cost and tokens** in outputs for every result
- **Supports multi-model, multi-prompt, and fusion** as optional orchestrations
- **Keeps the action small** — the runtime lives in the workflow, the action
  is a shell-out + comment poster

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Actions Workflow                     │
│                                                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │ Install OpenCode │  │ Install Skills  │  │ Write         │  │
│  │ (curl | bash)    │  │ (npx skills add) │  │ opencode.json │  │
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘  │
│           │                    │                  │          │
│           └────────────────────┴──────────────────┘          │
│                                │                             │
│                                ▼                             │
│              ┌────────────────────────────────┐             │
│              │  jander99/ai-review-action@v1   │             │
│              │   run-reviews  + post-comment   │             │
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

The action shrinks to two steps:

1. **`run-reviews`** — resolves target, builds prompts, calls `opencode run`,
   parses `--format json`, aggregates results.
2. **`post-comment`** — unchanged from v1.

The `opencode.json` config is the **runtime contract**. Whoever controls the
repo controls the agent's tools, models, permissions, and skills. Same trust
boundary as today, but the surface is plain JSON instead of action inputs.

## 4. Key Decisions

### 4.1 `bash: allow` is the default permission

The current prompts tell the model to run `git log`, `git diff`, etc. The
v2 prompts do the same. The OpenCode permission engine is **all-or-nothing
at the tool level** — there is no fine-grained sub-command allow-list that
reliably works (verified: nested `{ "git *": "allow", "*": "deny" }` does
not enforce — bash is denied entirely or allowed entirely).

**Decision**: default `permission: { bash: "allow" }` in the action's
generated `opencode.json`. Safety is the **GitHub token scope** in the
workflow (`permissions: contents: read` + read-only `GITHUB_TOKEN`), not an
app-level sandbox. The user can override to `bash: "deny"` for tighter
restrictions at the cost of pre-computing the diff.

### 4.2 API keys via env vars, non-interactive

`opencode run` reads per-provider env vars at startup. The `opencode auth
login` command is interactive (requires a TTY for `prompts.password()`) and
has no `--api-key` flag. The only CI-safe path is env vars.

**Decision**: the action does not handle auth itself. The workflow injects
env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`,
`KIMI_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, etc.) and `opencode.json`
interpolates them via `{env:VAR}`.

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
`cost` per call. The action parses JSONL, aggregates, and surfaces:

- `cost` — total USD across all calls
- `cost-by-model` — JSON object, per-model
- `tokens` — total `{input, output}`
- `tokens-by-model` — JSON object, per-model

Users can track spend per provider / per model without instrumenting the
action themselves.

### 4.5 The runtime is the workflow's responsibility

The action does not install OpenCode, install skills, install plugins, or
write the `opencode.json`. The workflow does. This is the inverse of v1:

| Concern | v1 (Copilot CLI) | v2 (OpenCode) |
|---|---|---|
| Install runtime | `action.yml` inline | workflow step |
| Install skills | not supported | `npx skills add` |
| Write `opencode.json` | not supported | workflow step (or committed) |
| Install plugins | not supported | `opencode.json` plugin field |
| Inject auth | `copilot-token` input | env vars |
| Gatekeep git | `--allow-tool=shell(git:*)` | `contents: read` + read-only token |

The action's `run-reviews` step assumes OpenCode is already installed and
the working directory contains a valid `opencode.json` (or the action
generates one from its inputs).

## 5. Action Interface

### 5.1 `run-reviews` inputs

| Input | Default | Description |
|---|---|---|
| `model` | `anthropic/claude-sonnet-4.6` | Single model (provider/model). Used when `models` is empty. |
| `models` | *(empty)* | Comma-separated list for multi-model runs. |
| `prompts` | `code-review` | Comma-separated prompt file paths (built-in names or workspace paths). |
| `target` | *(auto-resolve)* | `diff` \| `full`. Auto-resolves to `diff` on `pull_request`, `full` on push to default branch. |
| `opencode-config` | *(none)* | Path to a user-provided `opencode.json`. Overrides the generated one. |
| `permission` | `{"bash":"allow"}` | JSON string for the `permission` block. |
| `opencode-version` | `1.18.4` | Pinned OpenCode version (match the verified contract). |
| `timeout-minutes` | `30` | Per-call timeout. |
| `fusion` | `false` | Run a synthesis pass combining all individual results. |
| `fusion-model` | *(first model)* | Single model for fusion. Must be a single model name, not a list. |
| `fail-on-error` | `false` | Exit non-zero if all reviews fail. |

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

Unchanged from v1.

### 5.4 Prompt Composition

The action composes prompts in two layers — a **baked-in system prompt**
the action owns and a **user input** the workflow provides. The model
never sees the user's input in isolation; it sees the composed prompt.

```
┌─────────────────────────────────────────┐
│  System Prompt (action-owned, fixed)    │
│  · Environment description              │
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

**System prompt** (action-owned, not overridable):
- Explains the runtime environment (GitHub Actions runner, OpenCode CLI,
  available MCP tools / plugins / skills)
- **Context hints** that steer the model toward the right tool calls:
  - Pull-request context: `target: diff`, base/head refs, "use `git diff
    origin/$BASE_REF...HEAD` to see the changes"
  - Full-code context: `target: full`, "use file reads (`read`, `glob`,
    `grep`) to inspect the codebase"
- Defines the output format (markdown structure, severity legend, length
  guidance, no-preamble rule)
- Sets behavior defaults (what to do when no issues are found, how to
  handle ambiguity)

The system prompt is **parameterized** with runtime context the action
detects from `github.event_name`, `github.event.*`, and resolved `target`.
The action renders the system prompt with the appropriate context before
appending the user input.

The system prompt is exposed via the `AI_REVIEW_SYSTEM_PROMPT` environment
variable for advanced users to inspect before invoking the action.

**User input** (user-provided, via `prompts:`):
- A workspace-relative path (e.g., `.github/prompts/code-review.md`) — the
  action reads the file at runtime
- An inline string in the action input — the action uses it directly
- Comma-separated lists for multi-prompt runs

**Build prompt step pattern** (recommended): the workflow composes the
substantive prompt content in a pre-step (read files, generate context,
substitute variables), then passes the resulting path to the action. This
keeps the action's prompt-handling logic simple and lets users do
arbitrary pre-processing.

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

The action's `prompts:` input accepts both repo-relative paths and
absolute paths in the runner filesystem.

## 6. OpenCode Runtime Contract

The action shells out to `opencode run <prompt> --model <provider/model>
--format json` and parses the JSONL output. The contract is:

| Surface | Behavior |
|---|---|
| Prompt | Positional argument (or stdin via `< echo`). |
| Model | `--model provider/model` flag. |
| Format | `--format json` emits JSONL events. **Verified** in 1.18.4 — `step_finish` arrives with full `tokens` and `cost`. |
| Env vars | Per-provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, etc.). |
| Skills | Auto-loaded from `.claude/skills/`, `.opencode/skills/`, `.agents/skills/`. |
| MCPs | Declared in `opencode.json` `mcp` section, auto-spawned on `opencode run`. |
| Plugins | Declared in `opencode.json` `plugin` field. |
| Permissions | `opencode.json` `permission` block, flat shape: `{ "bash": "allow" }`. |

### 6.1 `opencode.json` provider shape

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

### 6.2 `opencode.json` MCP server shape

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

Auto-spawned on `opencode run`. No adapter needed — the action does not
speak MCP itself.

### 6.3 Permission shapes that work (verified)

| Shape | Behavior |
|---|---|
| `{"bash":"allow"}` | Allows all shell commands. |
| `{"bash":"deny"}` | Denies all shell commands entirely. |
| `{"bash":"allow","edit":"deny","read":"allow","glob":"allow","grep":"allow"}` | Mix of allow/deny per tool. |
| `{"bash":{"git *":"allow","*":"deny"}}` | **Does not work**. Nested shape is rejected; bash is denied entirely. |

Use the flat shape. The action's default is `{"bash":"allow"}`.

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
- Defaults to `permission: { bash: "allow" }` (the user's choice — they can
  tighten to `deny` if they want)
- Surfaces cost and tokens so token abuse is visible

**What the workflow does for safety**:

- `permissions: contents: read` in the workflow YAML
- Read-only `GITHUB_TOKEN` (the default for `${{ github.token }}` if no
  `permissions:` block asks for more)
- Limited `id-token: none`, `packages: none`, etc. — explicit denials
- MCPs that need write access (e.g., `github_delete_file`) require the
  workflow author to opt in

**What we deliberately do NOT do**:

- App-level sandboxing of the model (the OpenCode permission engine is too
  coarse and the cost outweighs the benefit)
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

### 9.3 User-provided `opencode.json` (full control)

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

## 10. Open Questions

*(none — all open questions resolved)*

## 11. Resolved Decisions

1. **Default prompt target on the default branch** *(resolved: full-code review)*.
   On push to the default branch, the action treats `target` as `full` and
   runs the same prompt against the full repo instead of a diff. Same prompt,
   different resolution. The `target` input still overrides this if the user
   explicitly sets `target: diff`.
2. **Prompt authoring** *(resolved: hybrid — action-owned system prompt + user-authored input)*.
   The action ships a baked-in system prompt that handles environment description,
   output format, and severity legend. Users provide the substantive content via
   `prompts:` (workspace path or inline string). The action composes the final
   prompt as `[system prompt] + [user input]`. The system prompt is exposed via
   the `AI_REVIEW_SYSTEM_PROMPT` env var for inspection. See section 5.4 for the
   full composition model.
3. **opencode-config validation** *(resolved: strict schema validation)*.
   When the user provides `opencode.json` via `opencode-config:`, the action
   fetches the `$schema` URL declared in the file and validates the user's
   config against it. Catches field errors and version mismatches early with
   clear error messages. Falls back to a clear error if the schema cannot be
   fetched (network failure). The action does NOT validate the auto-generated
   `opencode.json` (it controls that path).
4. **Diff resolution** *(resolved: model computes via tool call)*.
   The action does NOT pre-compute the diff — `git diff` as a string in the
   prompt doesn't scale. The system prompt steers the model toward the right
   tool calls (`git diff` for `target: diff`, file reads for `target: full`),
   and the model fetches the diff (or reads the repo) itself. Implication:
   `bash: allow` is required for diff mode; `bash: deny` is not supported
   for diff mode (the model can't fetch the diff). The action's system prompt
   adjusts its hints based on the resolved `target`.

## 12. Future Work

### 11.1 OpenCode-as-tests on Actions

A separate marketplace action that uses the same runtime contract but is
shaped for testing OpenCode itself or testing user code with OpenCode:
matrix of providers × models, no `contents: read` boundary, posts results
as artifacts instead of PR comments.

### 11.2 Skill registry

A curated registry of review-relevant skills (e.g., `code-review`,
`security-review`, `dependency-review`) discoverable via `npx skills find`.
The action's built-in prompts in v1 become community skills in v2.

### 11.3 Plugin ecosystem

OpenCode's plugin model is open. Review-specific plugins (LSP-based code
analysis, formatter enforcement, license checks) can be composed without
forking the action.

### 11.4 Multi-agent reviews

OpenCode sessions support multi-turn. A future iteration could orchestrate
a multi-agent review (one agent drafts, another critiques, a third
synthesizes) entirely in `opencode` without the action owning the loop.

## 13. References

- OpenCode CLI: https://opencode.ai/docs
- OpenCode `opencode.json` schema: https://opencode.ai/config.json
- MCP server config: https://opencode.ai/docs/mcp-servers
- Provider list: https://opencode.ai/docs/providers
- `npx skills` (Vercel Labs): https://github.com/vercel-labs/skills
- Vercel AI SDK: https://ai-sdk.dev/v7/docs
- Current v1 action: see `README.md` and `action.yml`
