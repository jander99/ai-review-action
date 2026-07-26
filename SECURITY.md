# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/jander99/ai-review-action/security/advisories/new). Do not open a public issue with exploit details, credentials, workflow logs, or debug artifacts.

Include the affected action commit SHA, OpenCode version, event type, runner type, minimal reproduction, and potential impact. Remove or replace all real secrets before attaching evidence.

## Trust model

AI Review Action has no application-level sandbox. The **workflow author is the trust boundary** and is responsible for the checked-out code, action commit, OpenCode version and checksum, models, prompts, skills, plugins, MCPs, credentials, token permissions, and optional OpenCode configuration used by the run.

The action is intended for review-oriented workloads, but the model executes on the GitHub Actions runner. Default direct-edit permission requires confirmation; default Bash permission is broad and can read or change runner state.

## Supply-chain contract

OpenCode installation is intentionally separate from the root action:

- `setup-opencode` supports Linux x64 only.
- The workflow selects an exact version and supplies the SHA-256 of that version's `opencode-linux-x64.tar.gz` release asset.
- The installer validates the checksum format, downloads the version-specific archive, and compares its SHA-256 before extraction.
- A mismatch fails installation; the unverified archive is not installed.
- The root action separately asserts that `opencode --version` exactly matches `opencode-version`.

Pin both `jander99/ai-review-action/setup-opencode` and the root action to the same full commit SHA in production. A checksum protects the OpenCode archive, while the action commit pin protects the download, verification, and review logic.

## Known limitations

- **Environment-key exfiltration:** with `bash: allow`, a model can read provider keys and other environment variables and may transmit them. Use short-lived, least-privilege credentials and trusted workflow composition.
- **No Bash sub-command allow-list:** OpenCode's permission engine does not reliably restrict Bash to commands such as `git`. Disable Bash through the `permission` input if this risk is unacceptable.
- **Untrusted repository instructions:** checked-out code, `AGENTS.md`, and skill/instruction directories remain visible to the model and can influence behavior.
- **Fork pull requests:** repository secrets are withheld from fork workflows and `GITHUB_TOKEN` may be read-only. Provider calls or result posting can therefore fail. Do not use `pull_request_target` to expose secrets to untrusted fork code.
- **No completeness guarantee:** the model decides what to inspect. The action does not prove that a complete, correct, or non-malicious review occurred.
- **No platform sandbox:** Linux x64 support is an installer compatibility statement, not isolation from the host runner.

## Configuration protections

Before invoking OpenCode, the action removes workspace-root `opencode.json` and `opencode.jsonc`, creates an action-owned agent definition, and uses a temporary merged config and temporary OpenCode home. A workflow-selected config can still add providers, plugins, and MCPs, so only select trusted configuration and dependencies.

Keep workflow permissions minimal:

- `contents: read` and `pull-requests: write` for PR comments;
- `contents: read` and `checks: write` for non-PR check runs; or
- `contents: read` with publishing disabled when only outputs are needed.

## Debug artifacts

Debug mode is opt-in. It captures OpenCode JSONL and stderr, redacts known credential patterns on a **best-effort** basis, gzips the files, and uploads them as the `ai-review-debug` artifact with seven-day retention.

Pattern-based redaction is not a guarantee. Unknown key formats, AWS secret access keys without a recognizable prefix, source code, prompts, model output, URLs, and other sensitive values may remain. Enable debug only on trusted runs, restrict artifact access, inspect before sharing, and delete the artifact early when it is no longer needed.

For the complete rationale and accepted risks, see the [design vision](docs/design-vision.md).
