# copilot-review

[![CI](https://github.com/jander99/copilot-action/actions/workflows/example-copilot-review.yml/badge.svg)](https://github.com/jander99/copilot-action/actions/workflows/example-copilot-review.yml)

## Overview

AI-powered pull request reviews using the GitHub Copilot CLI. This action
supports multi-model evaluations, multi-prompt strategies, and fusion synthesis
to provide high-quality feedback directly on your pull requests.

## Breaking Changes

The following inputs were changed or removed. Update your workflows accordingly.

| Old Input | New Input | Notes |
| :--- | :--- | :--- |
| `model` | `models` | Same value; now accepts comma-separated list for sequential runs. |
| `prompt` | `prompts` | Inline text removed; use built-in names or workspace-relative file paths. |
| `prompt-file` | `prompts` | Pass a workspace-relative path as a `prompts` entry. |
| `allowed-tools` | `allow-all-tools` | Boolean; `true` enables `--yolo` (full tool access), `false` (default) restricts to `shell(git:*)`. |
| `github-token` | *(optional)* | Now optional; falls back to `github.token` automatically. |

## Prerequisites

- **GitHub Checkout**: Must use `actions/checkout` with `fetch-depth: 0`.
  Shallow clones prevent git from generating the full diff needed for reviews.
- **Fine-grained PAT**: A fine-grained Personal Access Token with
  "Copilot Requests" permission is required for `copilot-token`. Classic PATs
  (`ghp_`) are not supported by the Copilot CLI.
- **Active Subscription**: The user account associated with the PAT must have
  an active GitHub Copilot subscription.

## Quick Start

```yaml
name: Review
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6.0.2
        with:
          fetch-depth: 0
      - uses: jander99/copilot-action@v1
        with:
          copilot-token: ${{ secrets.COPILOT_PAT }}
```

## Inputs

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `github-token` | String | No | `github.token` | `GITHUB_TOKEN` or fine-grained PAT for posting PR comments. Falls back to `github.token` when omitted; requires `pull-requests: write` permission. |
| `copilot-token` | String | Yes | | Fine-grained PAT with "Copilot Requests" permission. Classic PATs (`ghp_`) are NOT supported. |
| `models` | String | No | `claude-sonnet-4.6` | Comma-separated list of models to run sequentially. Each model is called once per prompt. |
| `prompts` | String | No | `code-review` | Comma-separated list of built-in prompt names (`code-review`, `security-review`, `dependency-review`, `test-coverage`) or workspace-relative file paths. Runs sequentially. |
| `fusion` | Boolean | No | `false` | Run a synthesis pass combining all individual reviews into one summary. |
| `fusion-model` | String | No | first entry of `models` | Single model for the fusion synthesis pass. Must be a single model name, not a list. |
| `post-comment` | Boolean | No | `true` | Post the review as a PR comment. |
| `allow-all-tools` | Boolean | No | `false` | Pass `--yolo` to the Copilot CLI, granting full tool access. Use with caution. |
| `min-prompt-length` | Number | No | `50` | Minimum character length for the PR diff. Reviews are skipped when the diff is smaller than this value. |
| `fail-on-error` | Boolean | No | `false` | When `true`, exits with a non-zero status if all reviews fail. When `false` (default), the action always exits successfully even if no reviews ran. |
| `max-comment-chars` | Number | No | `65000` | Truncate the PR comment at this many characters. GitHub hard-limits comments to 65,536 characters. |

## Outputs

| Name | Description |
| :--- | :--- |
| `review` | Full review text from the last model/prompt or the fusion review. |
| `comment-url` | URL of the posted PR comment. |
| `models-used` | Comma-separated list of successful models. |

## Examples

### Multi-Model Review

Run the same review prompt through multiple models and post the results.

```yaml
- uses: jander99/copilot-action@v1
  with:
    copilot-token: ${{ secrets.COPILOT_PAT }}
    # Models run sequentially — each model reviews the PR once per prompt.
    models: "claude-sonnet-4.6, gpt-4o"
```

### Custom Prompt File

Use a specialized prompt stored in your repository.

```yaml
- uses: jander99/copilot-action@v1
  with:
    copilot-token: ${{ secrets.COPILOT_PAT }}
    prompts: ".github/prompts/performance-review.md"
```

### Fusion Mode

Synthesize findings from multiple models into one cohesive summary.

```yaml
- uses: jander99/copilot-action@v1
  with:
    copilot-token: ${{ secrets.COPILOT_PAT }}
    models: "claude-sonnet-4.6, gpt-4o"
    fusion: true
```

### All Built-in Prompts

Enable every built-in review strategy in one pass.

```yaml
- uses: jander99/copilot-action@v1
  with:
    copilot-token: ${{ secrets.COPILOT_PAT }}
    prompts: "code-review, security-review, dependency-review, test-coverage"
```

## Security Considerations

- **Tool Access**: By default, the Copilot agent is restricted to `shell(git:*)`.
  Setting `allow-all-tools: true` passes `--yolo` to the CLI, granting full tool access to your CI environment. Use with caution.
- **Trigger Events**: This action **must** use the `pull_request` event. Using
  `pull_request_target` is a serious security risk as it exposes the
  `copilot-token` (a fine-grained PAT) to pull requests from forks.
- **Instruction Injection**: The Copilot CLI automatically loads
  `.copilot/instructions.md` and `AGENTS.md` from the repository.
- **Fork Pull Requests**: Comment posting may fail because the default
  `GITHUB_TOKEN` has read-only scope on pull requests from forks. The action
  will exit gracefully (Exit 0) in these scenarios.

## Troubleshooting

- **Copilot CLI not found**: Ensure you haven't overridden the action's internal
  installation step. The action installs its own dependencies.
- **403 on comment post**: Verify that your workflow has
  `pull-requests: write` permission. If using a custom `github-token`, ensure it has that permission.
- **Empty review output**: The PR diff might be smaller than
  `min-prompt-length`. Check logs for "diff is smaller than min-prompt-length".
- **Classic PAT not supported**: If you see authentication errors, ensure
  `copilot-token` is a fine-grained PAT with "Copilot Requests" permission.

## Development

This is an NX monorepo with two TypeScript packages compiled via esbuild.

### Structure

```
copilot-action/
├── action.yml                  # Composite action entrypoint
├── packages/
│   ├── run-reviews/            # Drives Copilot CLI and collects reviews
│   │   ├── src/main.ts
│   │   ├── prompts/            # Built-in prompt files
│   │   └── dist/main.cjs       # Compiled artifact (committed)
│   └── post-comment/           # Posts the review as a PR comment
│       ├── src/main.ts
│       └── dist/main.cjs       # Compiled artifact (committed)
├── tsconfig.base.json
└── nx.json
```

### Building

```bash
yarn install
yarn build             # equivalent to: yarn nx run-many --target=build
```

Each package compiles to `dist/main.cjs` inside its own directory. These artifacts are committed so the action can run without a build step in consuming workflows.

### Adding or Editing Prompts

Built-in prompts live in `packages/run-reviews/prompts/`. Add a `.md` file there and it will be available by name (without the `.md` extension) via the `prompts` input.

## License

MIT
