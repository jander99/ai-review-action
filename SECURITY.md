# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/jander99/ai-review-action/security/advisories/new). Do not open a public issue with exploit details, credentials, or workflow logs.

Include the affected action commit SHA, event type, runner type, providers used, minimal reproduction, and potential impact. Remove or replace all real secrets before attaching evidence.

## Trust model

The **workflow author is the trust boundary**. They choose the checked-out code, the action commit, the providers and models, the prompts, the credentials, and the token permissions.

The action makes no tool calls on the runner on behalf of a model. Models only return text: the proposing LLM returns schema-checked JSON, and the decision API returns typed probabilities. Nothing a model returns is executed. The action has no repo-exploring agent and no Bash, file-edit or network tool exposed to a model.

## What leaves the runner

The diff, the changed files' text, and repository instruction files go to the proposing LLM provider. Each finding, with its evidence and surrounding context, goes to the decision provider. You opt into both by configuring them. See "What gets sent where" in the README.

## Credential handling

- Keys are passed only through the `llm-api-key` and `decision-api-key` inputs and are masked in logs.
- Adapters never read `process.env`. They pass the key and base URL explicitly to each SDK, so a runner environment variable such as `OPENAI_BASE_URL` or `ANTHROPIC_API_KEY` cannot redirect traffic or substitute a credential.
- No adapter logs a request body, header or key, and adapter errors are redacted against the configured key.
- Use least-privilege, revocable keys. A custom `*-base-url` receives the key, so only point it at endpoints you trust.

## Prompt injection

PR content is untrusted. The diff, file text and PR title/body are delimited data in the prompts, with closing delimiters neutralized. Repository instruction files (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`) are read from the **base** commit, so a pull request cannot change the rules it is reviewed under. Proposer output is treated as untrusted when it enters the judge's input. A model can still be misled into a wrong finding, so treat reviews as advice.

## Known limitations

- **Fork pull requests:** repository secrets are withheld from fork workflows and `GITHUB_TOKEN` may be read-only, so provider calls or posting can fail. Do not use `pull_request_target` to expose secrets to untrusted fork code.
- **No completeness guarantee:** the review covers the filtered diff and fetched context only. It does not prove that a complete, correct or non-malicious review occurred.
- **Not bit-repeatable:** no provider offers a seed for the decision API, and the proposer is non-deterministic.
- **Third-party processing:** code goes to two third parties. Review their retention and training terms before enabling the action on private code.

## Permissions

Keep workflow permissions minimal:

- `contents: read` and `pull-requests: write` for PR reviews;
- `contents: read` and `checks: write` for non-PR check runs; or
- `contents: read` with publishing disabled when only outputs are needed.

For the design rationale, see the [design vision](docs/design-vision.md).
