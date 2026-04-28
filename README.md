# copilot-review

[![CI](https://github.com/jander99/copilot-action/actions/workflows/example-copilot-review.yml/badge.svg)](https://github.com/jander99/copilot-action/actions/workflows/example-copilot-review.yml)

## Overview

AI-powered pull request reviews using the GitHub Copilot CLI. This action
supports multi-model evaluations, multi-prompt strategies, and fusion synthesis
to provide high-quality feedback directly on your pull requests.

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
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jander99/copilot-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          copilot-token: ${{ secrets.COPILOT_PAT }}
```

## Inputs

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `github-token` | String | Yes | | `GITHUB_TOKEN` or fine-grained PAT. |
| `copilot-token` | String | Yes | | Fine-grained PAT with "Copilot Requests". |
| `model` | String | No | `claude-sonnet-4.6` | Model to use for reviews. |
| `models` | String | No | | Comma-separated list of models. |
| `prompt` | String | No | | Inline prompt text. |
| `prompt-file` | String | No | | Path to a markdown file containing prompt. |
| `prompts` | String | No | | Comma-separated list of built-in prompts. |
| `fusion` | Boolean | No | `false` | Run a synthesis pass. |
| `fusion-model` | String | No | | Model to use for the fusion pass. |
| `post-comment` | Boolean | No | `true` | Post the review as a PR comment. |
| `allowed-tools` | String | No | `shell(git:*)` | Tool permissions. |
| `min-prompt-length` | Number | No | `50` | Min char length for the PR diff. |
| `max-comment-chars` | Number | No | `65000` | Truncate the PR comment. |

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
    github-token: ${{ secrets.GITHUB_TOKEN }}
    copilot-token: ${{ secrets.COPILOT_PAT }}
    models: "claude-sonnet-4.6, gpt-4o"
```

### Custom Prompt File

Use a specialized prompt stored in your repository.

```yaml
- uses: jander99/copilot-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    copilot-token: ${{ secrets.COPILOT_PAT }}
    prompt-file: ".github/prompts/performance-review.md"
```

### Fusion Mode

Synthesize findings from multiple models into one cohesive summary.

```yaml
- uses: jander99/copilot-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    copilot-token: ${{ secrets.COPILOT_PAT }}
    models: "claude-sonnet-4.6, gpt-4o"
    fusion: true
```

### All Built-in Prompts

Enable every built-in review strategy in one pass.

```yaml
- uses: jander99/copilot-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    copilot-token: ${{ secrets.COPILOT_PAT }}
    prompts: "code-review, security-review, dependency-review, test-coverage"
```

## Security Considerations

- **Allowed Tools**: The `allowed-tools` input defaults to `shell(git:*)`.
  Expanding this grants the Copilot agent broader access to your CI environment.
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
- **403 on comment post**: Verify that your `github-token` has
  `pull-requests: write` permission.
- **Empty review output**: The PR diff might be smaller than
  `min-prompt-length`. Check logs for "diff is smaller than min-prompt-length".
- **Classic PAT not supported**: If you see authentication errors, ensure
  `copilot-token` is a fine-grained PAT with "Copilot Requests" permission.

## License

MIT
