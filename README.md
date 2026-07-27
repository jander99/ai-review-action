# AI Review Action

AI Review Action runs repository reviews through the OpenCode CLI using provider API keys supplied by your workflow. It supports one or many models and prompts, optional fusion, cost and token reporting, PR comments, non-PR check runs, user-composed OpenCode configuration, and opt-in debug capture.

## Prerequisites

- A **Linux x64** runner. macOS, Windows, Linux arm64, and other platforms are not supported.
- `actions/checkout@v6` with `fetch-depth: 0` so the model can inspect the complete Git history and base ref.
- `git`, `bash`, `tar`, and Node/npm tooling on `PATH`. `ubuntu-latest` provides these; Node 22+ is recommended when installing skills with `npx`.
- OpenCode installed by the standalone [`setup-opencode`](#opencode-installation) action with the SHA-256 checksum of the exact release archive.
- At least one provider credential exposed as an environment variable.
- A prompt using the `file:` or `text:` prefix.

## Quickstart

The repository includes a minimal prompt at `examples/prompts/code-review.md`. Configure `ANTHROPIC_API_KEY` as an Actions secret, then add this workflow. It uses the [vetted OpenCode 1.18.5 checksum](#vetted-opencode-versions):

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

      # For production, replace v1 with a full ai-review-action commit SHA.
      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      # Pin this to the same full commit SHA in production.
      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The examples use `@v1` for readability. In production, resolve the `v1` release or tag to its full commit SHA on the repository's Releases or Commits page and use that SHA for both action references, for example `jander99/ai-review-action@<full-commit-sha>`.

### `setup-opencode` inputs

| Input | Required | Default | Description |
|---|---:|---|---|
| `version` | No | `1.18.5` | OpenCode version to install. |
| `checksum` | **Yes** | None | SHA-256 of the selected OpenCode tarball. Use a value from [Vetted OpenCode versions](#vetted-opencode-versions). |
| `install-dir` | No | `~/.opencode` | Directory where the `opencode` binary is placed. |

## How it works

```text
┌──────────────────────────────────────────────┐
│ 1. Workflow                                 │
│ checkout, provider secrets, prompts/config  │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ 2. setup-opencode                           │
│ download pinned Linux-x64 archive           │
│ → verify workflow-supplied SHA-256 → install│
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ 3. AI Review Action                         │
│ run-reviews                                 │
│ → post-comment (pull_request)               │
│ → post-check-run (other events)             │
└──────────────────────────────────────────────┘
```

1. The workflow owns checkout, credentials, prompts, skills, MCPs, plugins, and optional user configuration.
2. `setup-opencode` installs the exact requested OpenCode version only after the supplied archive checksum matches.
3. `run-reviews` creates an isolated merged configuration and invokes OpenCode for the stable lexical cross-product of prompts and models. The root action then posts a PR comment or check run.

The action does not materialize a diff. It injects event and ref context into the action-owned agent definition, and the model uses Git to decide what to review.

## Inputs

These are all inputs accepted by the root `jander99/ai-review-action` action.

| Input | Required | Default | Description |
|---|---:|---|---|
| `opencode-version` | No | `1.18.5` | Exact version expected from `opencode --version`. Installation remains the workflow's responsibility. |
| `debug` | No | `false` | Capture OpenCode stdout/stderr, apply best-effort redaction, gzip the files, and upload the `ai-review-debug` artifact for 7 days. |
| `github-token` | No | `${{ github.token }}` | Token used to publish a PR comment or check run. Its permissions must match the event. |
| `model` | No | `anthropic/claude-sonnet-4.6` | Single OpenCode model in `provider/model` form. Used when `models` is empty. |
| `models` | No | Empty | Comma-separated OpenCode models. When set, this overrides `model`. |
| `prompts` | **Yes** | None | Comma-separated prompt sources. Each entry must begin with `file:` or `text:`. |
| `opencode-config` | No | None | Path to a user-provided `opencode.json` or `opencode.jsonc` to merge into the isolated action configuration. |
| `permission` | No | [Explicit per-tool defaults](#default-tool-permissions) | JSON object replacing the OpenCode permission block. |
| `timeout-minutes` | No | `30` | Timeout for each review or fusion invocation. Must be a positive integer. |
| `fusion` | No | `false` | Run a tool-disabled synthesis pass over successful individual reviews. |
| `fusion-model` | No | First effective model | Model used for the fusion pass. |
| `fail-on-error` | No | `false` | Fail the step when any review or fusion operation fails. Setup and validation failures always fail. |
| `post-comment` | No | `true` | Publish on `pull_request` events. Set to `false` to consume outputs without commenting. |
| `post-check-run` | No | `true` | Publish on non-PR events. Set to `false` to consume outputs without creating a check run. |
| `max-comment-chars` | No | `65000` | Maximum PR comment length before truncation. |
| `check-name` | No | `ai-review` | Name of the check run created for non-PR events. |
| `check-conclusion` | No | `neutral` | Check conclusion: `action_required`, `cancelled`, `failure`, `neutral`, `success`, `skipped`, `stale`, or `timed_out`. |
| `check-details-url` | No | `https://github.com` | URL linked from a non-PR check run. |

Prompt entries are parsed prefix-first:

- `file:path` reads a workspace-relative or absolute file.
- `text:content` uses the literal content after `text:`.

### Default tool permissions

Unless `permission` is supplied, the generated OpenCode configuration uses:

```json
{
  "read": "allow",
  "glob": "allow",
  "grep": "allow",
  "list": "allow",
  "webfetch": "allow",
  "edit": "ask",
  "question": "ask",
  "doom_loop": "ask",
  "bash": "allow"
}
```

OpenCode does not currently provide reliable sub-command allow-lists. `bash: allow` is therefore broad runner access, not a sandbox boundary.

## Outputs

| Output | Description |
|---|---|
| `review` | Synthesized text when fusion succeeds; otherwise all successful individual reviews labeled `<model> :: <prompt>` and separated by `---`. Empty when no reviews succeed. |
| `comment-url` | URL of the posted PR comment. Empty for non-PR events, disabled posting, or unsuccessful posting. |
| `check-run-url` | URL of the non-PR check run. Empty for PR events or when check-run posting is disabled. |
| `models-used` | Comma-separated models that completed successfully. |
| `cost` | Total reported cost in USD across successful review and fusion calls. |
| `cost-by-model` | JSON object mapping each model to its reported USD cost. |
| `tokens` | JSON object with total `input` and `output` token counts. |
| `tokens-by-model` | JSON object mapping each model to its `input` and `output` token counts. |
| `debug-artifact-path` | Runner directory containing redacted, gzipped debug files when `debug: true`. The root action uploads this directory automatically. |

## Sample workflows

The samples below correspond to the design vision's workflows 11.1–11.8. They assume:

- The vetted `1.18.5` checksum is embedded directly in each setup step.
- Prompt and configuration files are available under this repository's `examples/` directory; copy them when adapting a sample elsewhere.
- Referenced provider keys are configured as Actions secrets.
- `@v1` is replaced with one full action commit SHA for production use.

### 11.1 Quickstart (with standalone setup step)

Run one prompt with one Anthropic model and publish the result as a PR comment.

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

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 11.2 Default workflow permissions

Omit an explicit workflow `permissions` block and inherit the repository or organization token defaults; comment posting may be unavailable.

```yaml
name: AI Review (default token permissions)
on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 11.3 Multi-model with fusion

Run every prompt against both models, then synthesize the successful results with Claude.

```yaml
name: AI Review (multi-model fusion)
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

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      - uses: jander99/ai-review-action@v1
        with:
          models: "anthropic/claude-sonnet-4.6, openai/gpt-4o"
          prompts: "file:examples/prompts/code-review.md, file:examples/prompts/security-review.md"
          fusion: true
          fusion-model: anthropic/claude-sonnet-4.6
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### 11.4 User-provided `opencode.json`

Merge the trusted `examples/opencode.json` configuration while preserving action-required agent, model, provider, and permission settings. The example uses OpenCode's `{env:GITHUB_TOKEN}` interpolation; the action does not expand `${VAR}` placeholders in user configuration.

```yaml
name: AI Review (custom OpenCode config)
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

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      - uses: jander99/ai-review-action@v1
        with:
          opencode-config: examples/opencode.json
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

### 11.5 With skills and MCPs

Install a trusted skill before review; MCP servers and plugins can be declared in the file selected by `opencode-config`.

```yaml
name: AI Review (skills)
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

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      - name: Install skills
        run: npx -y skills@1 add vercel-labs/agent-skills --agent opencode --yes

      - uses: jander99/ai-review-action@v1
        with:
          models: "anthropic/claude-sonnet-4.6"
          opencode-config: examples/opencode.json
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

### 11.6 Custom provider (MiniMax)

Use the built-in MiniMax provider definition by exposing `MINIMAX_API_KEY`.

```yaml
name: AI Review (MiniMax)
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

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      - uses: jander99/ai-review-action@v1
        with:
          model: minimax/minimax-m3
          prompts: file:examples/prompts/code-review.md
        env:
          MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

### 11.7 Debug mode

Upload redacted and gzipped OpenCode JSONL/stderr streams as an `ai-review-debug` workflow artifact.

```yaml
name: AI Review (debug)
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

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
          debug: true
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 11.8 Push to the default branch

Publish the result as a check run named `ai-review` because no pull request is associated with the event.

```yaml
name: AI Review (default branch)
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
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/setup-opencode@v1
        with:
          version: 1.18.5
          checksum: cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/repo-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Required permissions

| Event or mode | Minimum workflow permissions | Publication destination |
|---|---|---|
| `pull_request` with posting | `contents: read`, `pull-requests: write` | PR comment |
| `push`, `workflow_dispatch`, or another non-PR event with posting | `contents: read`, `checks: write` | Check run |
| Outputs only (`post-comment: false` or `post-check-run: false`) | `contents: read` | None |

Provider API keys are separate from `GITHUB_TOKEN` permissions. Fork pull requests do not receive repository secrets, and GitHub may reduce `GITHUB_TOKEN` to read-only; see [Limitations](#limitations).

## Supported providers

Credentials are environment variables, not action inputs. Native providers are discovered by OpenCode. The action adds built-in configuration for the listed custom providers when their credential environment is present.

| Provider | Integration | Environment variables |
|---|---|---|
| Anthropic | OpenCode native | `ANTHROPIC_API_KEY` |
| OpenAI | OpenCode native | `OPENAI_API_KEY` |
| Google Gemini | OpenCode native | `GEMINI_API_KEY` |
| GitHub Copilot through OpenCode | OpenCode native | `GITHUB_TOKEN` with the required Copilot access |
| MiniMax | Built-in custom provider | `MINIMAX_API_KEY` |
| Kimi / Moonshot | Built-in custom provider | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |
| AWS Bedrock | Built-in custom provider | `AWS_BEARER_TOKEN_BEDROCK`, or standard AWS variables such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, or `AWS_WEB_IDENTITY_TOKEN_FILE`; region from `AWS_REGION`/`AWS_DEFAULT_REGION` |
| Google Vertex Anthropic | Built-in custom provider | `GOOGLE_APPLICATION_CREDENTIALS`; project from `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, or `GCP_PROJECT`; location from `GOOGLE_CLOUD_LOCATION` |
| Other providers | User-defined through `opencode-config` | Any `{env:USER_DEFINED_VAR}` referenced by that configuration |

For built-in providers, the merged configuration references secrets with OpenCode's `{env:VAR}` syntax rather than embedding key values.

## OpenCode installation

`setup-opencode` is a standalone action and must run before the root action. The root action's `opencode-version` input only asserts the version already installed on `PATH`.

The installation contract is deliberately explicit:

1. The workflow selects an OpenCode version and supplies the SHA-256 checksum.
2. `setup-opencode` supports **Linux x64 only** and downloads `opencode-linux-x64.tar.gz` from that exact GitHub release.
3. The action rejects a checksum that is not 64 hexadecimal characters.
4. It hashes the downloaded archive and stops before extraction if the value differs.
5. After verification, it extracts the binary, installs it atomically, and adds the install directory to `PATH`.

### Vetted OpenCode versions

Use the checksum below for the exact release asset named in the same row. Every workflow sample in this README pins this value directly.

| OpenCode version | Asset | SHA-256 |
|---|---|---|
| `1.18.5` | `opencode-linux-x64.tar.gz` | `cd4a2557a3d6550f27cb5c0257ebe8d73388bb34beda8b6121e6428a74c1eae2` |

This value was computed from the [`v1.18.5` Linux x64 release asset](https://github.com/anomalyco/opencode/releases/download/v1.18.5/opencode-linux-x64.tar.gz). An independent calculation of that exact archive must match the published value. Do not reuse a checksum for another version, platform, filename, or rebuilt archive.

The action itself should also be pinned by full commit SHA in production. The OpenCode archive checksum protects the downloaded runtime; the action commit SHA protects the installer and review logic.

## Security model

There is no application-level sandbox. The workflow author is the trust boundary and decides which code, models, prompts, skills, plugins, MCPs, credentials, and permissions enter the run.

The action's safety posture includes:

- deleting workspace-root `opencode.json` and `opencode.jsonc` before OpenCode starts;
- placing privileged review instructions in an action-owned agent definition;
- creating the merged config and isolated OpenCode home under the runner's temporary directory;
- using explicit per-tool permission defaults and a tool-disabled fusion pass;
- keeping provider credentials in environment variables rather than action inputs;
- exposing model-reported cost and token usage;
- asserting the installed OpenCode version;
- requiring checksum verification in the standalone installer; and
- making debug capture opt-in, compressed, short-lived, and redacted on a best-effort basis.

See [SECURITY.md](SECURITY.md) for reporting instructions and the full operational guidance. Detailed design rationale remains in the [design vision](docs/design-vision.md).

## Limitations

- **Environment-key exfiltration:** a model with `bash: allow` can read runner environment variables and may exfiltrate provider keys. Use narrowly scoped credentials and only trusted workflow composition.
- **No sub-command allow-lists:** OpenCode's permission engine cannot reliably limit Bash to selected commands. The choice is broad Bash access or disabling Bash through the `permission` input.
- **Fork pull requests:** GitHub does not pass repository secrets to workflows from forks, so provider authentication normally fails. Do not switch to `pull_request_target` to expose secrets to untrusted fork code.
- Repository instructions such as `AGENTS.md` and skill directories remain visible to the model and can influence it.
- Debug redaction recognizes known credential patterns only; artifacts can still contain sensitive content.
- The model decides what Git history and files to review. The action does not verify that a complete or correct review occurred.
- The bundled installer supports Linux x64 only.

## Documentation

- [Design vision](docs/design-vision.md) — architecture, safety model, runtime contract, and detailed design decisions.
- [Implementation plan](docs/implementation-plan.md) — phased delivery scope and risk register.
- [Review questions](docs/review-questions.md) — resolved design questions and the decisions log.
- [Contributing](CONTRIBUTING.md) — local development, smoke testing, provider changes, and contract-test guidance.
- [Security policy](SECURITY.md) — trust model, known limitations, supply-chain guarantees, and private reporting.

## Links

- [OpenCode documentation](https://opencode.ai/docs)
- [OpenCode configuration schema](https://opencode.ai/config.json)
- [OpenCode releases](https://github.com/anomalyco/opencode/releases)
- [AI Review Action repository](https://github.com/jander99/ai-review-action)

## License

MIT
