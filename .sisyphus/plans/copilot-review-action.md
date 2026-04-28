# copilot-review — GitHub Action

## TL;DR

> **Quick Summary**: Build a GitHub Action that uses the GitHub Copilot CLI to run AI-powered code reviews on pull requests, supporting multiple models, multiple prompt strategies, and optional fusion synthesis of results into a single PR comment.
>
> **Deliverables**:
> - `action.yml` — Action definition (inputs, outputs, runs: composite)
> - `scripts/run-reviews.sh` — Main orchestration script
> - `scripts/post-comment.sh` — PR comment posting with permission detection
> - `prompts/code-review.md` — Bundled general code review prompt
> - `prompts/security-review.md` — Bundled security-focused prompt
> - `prompts/dependency-review.md` — Bundled dependency review prompt
> - `prompts/test-coverage.md` — Bundled test coverage prompt
> - `README.md` — Marketplace-quality documentation
> - `.github/workflows/example-copilot-review.yml` — Example consumer workflow
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 (action.yml) → Task 5 (run-reviews.sh) → Task 6 (README) → Final QA

---

## Context

### Original Request
Build a GitHub Action wrapping the `@github/copilot` CLI to perform AI-powered PR reviews across multiple models and prompt strategies, with optional fusion synthesis and PR comment posting.

### Interview Summary
**Key Discussions**:
- Underlying API: Copilot CLI (`@github/copilot` npm package), not GitHub Models REST API
- Permission detection: sentinel write test — add `eyes` reaction, immediately delete; 403 = no write access, skip gracefully
- PR comment handling: keep spec approach (post as markdown comment), fix the permission detection mechanism
- Output capture: use `-s` (silent) + stdout redirect — NOT `--share` (too verbose) and NOT `2>&1` (pollutes review text)

**Research Findings**:
- `@github/copilot` package real: 458K weekly downloads, installs standalone `copilot` binary
- `--no-ask-user` flag: real and confirmed in official docs — prevents agent pausing for user input
- `--allow-tool='shell(git:*)'` format: real and documented
- Classic PATs (`ghp_`) explicitly NOT supported; fine-grained PAT with "Copilot Requests" permission required
- Token env var precedence: `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN`
- `claude-sonnet-4.6` explicitly used as example in official `--model` docs; valid model string
- `--no-custom-instructions`: Copilot CLI auto-loads AGENTS.md/custom instructions from checked-out repo; this flag prevents prompt injection via malicious PRs
- `COPILOT_AUTO_UPDATE=false`: CLI self-updates by default; must disable in CI for reproducibility

### Metis Review
**Identified Gaps (addressed)**:
- AGENTS.md injection risk: CLI auto-loads custom instructions from repo; `--no-custom-instructions` flag must be used (verify flag exists; document as known limitation if not)
- Shell injection via `allowed-tools` input: all user inputs must be shell-quoted before CLI interpolation
- Supply chain: pin npm package to specific version (not `@latest`)
- Auto-update: `COPILOT_AUTO_UPDATE=false` required in all copilot invocations
- Fork PR security: example workflow must use `pull_request` (not `pull_request_target`)
- Shallow clone: `fetch-depth: 0` required in prerequisite checkout step; document explicitly
- Input conflict resolution: `models` takes precedence over `model`; `prompt` takes precedence over `prompt-file`; both custom + built-in prompts run when both specified

---

## Work Objectives

### Core Objective
Deliver a production-quality, Marketplace-publishable GitHub Action that wraps the Copilot CLI for AI PR reviews, correctly using the documented CLI interface with all security guardrails applied.

### Concrete Deliverables
- `action.yml` with complete input/output schema
- `scripts/run-reviews.sh` orchestration (install CLI, run reviews, optional fusion)
- `scripts/post-comment.sh` with sentinel permission test
- 4 bundled prompt files in `prompts/`
- `README.md` with quickstart, all inputs documented, prerequisites, security notes
- `.github/workflows/example-copilot-review.yml` using `pull_request` trigger

### Definition of Done
- [ ] `action.yml` validates with `actionlint` (zero errors)
- [ ] `shellcheck scripts/*.sh` passes with zero errors
- [ ] `markdownlint-cli2 README.md` passes (zero errors)
- [ ] Integration test: action runs on a real PR in the repo and posts a comment

### Must Have
- Correct CLI invocation: `copilot -p "$(cat file)" -s --no-ask-user --allow-tool='...' --model "$model"`
- `COPILOT_AUTO_UPDATE=false` set in all copilot invocations
- `--no-custom-instructions` passed if the flag is confirmed to exist in the installed CLI version
- Pinned npm install: `npm install -g @github/copilot@VERSION` (not `@latest`)
- Sentinel permission test for PR comment posting
- All user inputs shell-quoted before CLI interpolation
- `pull_request` trigger in example workflow (NOT `pull_request_target`)
- Document `fetch-depth: 0` prerequisite in README
- Document fine-grained PAT requirement (not classic PAT)
- Document fork PR limitations

### Must NOT Have (Guardrails)
- ❌ No `2>&1` on the copilot output redirect (pollutes review text with stderr)
- ❌ No `@latest` in npm install (supply chain risk)
- ❌ No unquoted user inputs in shell commands (injection risk)
- ❌ No `pull_request_target` trigger in example workflow
- ❌ No inline/line-level review comments (only top-level PR comments)
- ❌ No PR state mutation (labels, approvals, merging, status checks)
- ❌ No update-existing-comment logic on re-runs (always create new)
- ❌ No GitHub Checks API integration
- ❌ No review caching or persistence between runs
- ❌ No GHES support
- ❌ No matrix parallelism (reviews run sequentially within the action)
- ❌ No excessive inline comments or AI-generated boilerplate in shell scripts
- ❌ No hardcoded model list validation (too fragile; models change; rely on CLI error)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: NO (this is a greenfield repo)
- **Automated tests**: NO (shell scripts; verified via shellcheck + integration test)
- **Agent-Executed QA**: YES — every task has concrete QA scenarios below

### QA Policy
- Shell scripts: `shellcheck` for static analysis + `bash -n` syntax check + integration execution
- YAML: `actionlint` for `action.yml`, `yamllint` for workflows
- Markdown: `markdownlint-cli2` for README
- Integration: actual action run on a real PR in this repo

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — all independent):
├── Task 1: action.yml [quick]
├── Task 2: prompts/code-review.md + prompts/security-review.md [quick]
├── Task 3: prompts/dependency-review.md + prompts/test-coverage.md [quick]
└── Task 4: scripts/post-comment.sh [unspecified-high]

Wave 2 (After Wave 1 — depends on action.yml + prompts + post-comment.sh):
└── Task 5: scripts/run-reviews.sh [deep]

Wave 3 (After Wave 2 — documentation and example):
├── Task 6: README.md [writing]
└── Task 7: .github/workflows/example-copilot-review.yml [quick]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit [oracle]
├── Task F2: Code quality review [unspecified-high]
├── Task F3: Real integration QA [unspecified-high]
└── Task F4: Scope fidelity check [deep]
→ Present results → Get explicit user okay

Critical Path: Task 1 → Task 4 → Task 5 → Task 6 → F1-F4 → user okay
Parallel Speedup: ~50% faster than sequential
Max Concurrent: 4 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 (action.yml) | — | 5 |
| 2 (prompts 1-2) | — | 5 |
| 3 (prompts 3-4) | — | 5 |
| 4 (post-comment.sh) | — | 5 |
| 5 (run-reviews.sh) | 1, 2, 3, 4 | 6, 7 |
| 6 (README.md) | 5 | F1-F4 |
| 7 (example workflow) | 5 | F1-F4 |
| F1-F4 | 6, 7 | done |

### Agent Dispatch Summary

- **Wave 1**: 4 agents — T1 → `quick`, T2 → `quick`, T3 → `quick`, T4 → `unspecified-high`
- **Wave 2**: 1 agent — T5 → `deep`
- **Wave 3**: 2 agents — T6 → `writing`, T7 → `quick`
- **Final**: 4 agents — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

---

- [x] 1. `action.yml` — Action definition with all inputs and outputs

  **What to do**:
  - Create `action.yml` with `name`, `description`, `branding` (color: blue, icon: eye)
  - `runs: using: composite` — all steps are shell scripts
  - Define inputs:
    - `github-token` (required, description: GITHUB_TOKEN or fine-grained PAT for posting comments)
    - `copilot-token` (required, description: Fine-grained PAT with "Copilot Requests" permission — classic PATs (ghp_) not supported)
    - `model` (optional, default: `claude-sonnet-4.6`, description: Model to use; see `copilot help` for available models)
    - `models` (optional, default: `''`, description: Comma-separated list of models; overrides `model` when set)
    - `prompt` (optional, default: `''`, description: Inline prompt text; takes precedence over `prompt-file`)
    - `prompt-file` (optional, default: `''`, description: Path to a markdown file containing the prompt)
    - `prompts` (optional, default: `''`, description: Comma-separated list of built-in prompts: `code-review`, `security-review`, `dependency-review`, `test-coverage`)
    - `fusion` (optional, default: `'false'`, description: Run a synthesis pass combining all individual reviews)
    - `fusion-model` (optional, default: `''`, description: Model for fusion pass; inherits `model` if empty)
    - `post-comment` (optional, default: `'true'`, description: Post review as PR comment)
    - `allowed-tools` (optional, default: `'shell(git:*)'`, description: Tool permissions for Copilot agent; WARNING: expanding beyond git shell tools grants the agent broader access to the CI environment)
    - `min-prompt-length` (optional, default: `'50'`, description: Minimum character length for PR diff; skip review if diff is smaller)
    - `max-comment-chars` (optional, default: `'65000'`, description: Truncate PR comment at this character count; max GitHub allows is 65536)
  - Define outputs:
    - `review` (value: `${{ steps.run.outputs.review }}`, description: Full review text from the last model/prompt combination, or fusion if enabled)
    - `comment-url` (value: `${{ steps.post.outputs.comment-url }}`, description: URL of the posted PR comment; empty if post-comment is false or permission was insufficient)
    - `models-used` (value: `${{ steps.run.outputs.models-used }}`, description: Comma-separated list of models that completed successfully)
  - Steps:
    1. Install dependencies: `npm install -g @github/copilot@1.0.37 markdownlint-cli2`
    2. Run reviews: call `${{ github.action_path }}/scripts/run-reviews.sh`
       - Set env: `COPILOT_GITHUB_TOKEN: ${{ inputs.copilot-token }}`, `COPILOT_AUTO_UPDATE: 'false'`
       - Pass all inputs as env vars prefixed `INPUT_*`
       - id: `run`
    3. Post comment: call `${{ github.action_path }}/scripts/post-comment.sh`
       - Set env: `GH_TOKEN: ${{ inputs.github-token }}`, `INPUT_POST_COMMENT: ${{ inputs.post-comment }}`, `INPUT_MAX_COMMENT_CHARS: ${{ inputs.max-comment-chars }}`, `GITHUB_PR_NUMBER: ${{ github.event.pull_request.number }}`
       - id: `post`
  - All scripts must be made executable: add `chmod +x` step before calling scripts

  **Must NOT do**:
  - Do NOT use `runs: using: node20` — this is a composite action
  - Do NOT hardcode any secrets in the YAML
  - Do NOT add `COPILOT_AUTO_UPDATE` to the public inputs (it's an internal security control)

  **Recommended Agent Profile**:
  > `action.yml` is a YAML configuration file with a well-defined schema. Quick task.
  - **Category**: `quick`
  - **Skills**: none needed

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: Task 5
  - **Blocked By**: None (can start immediately)

  **References**:
  - Pattern: `https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action` — composite action structure, outputs from steps
  - Pattern: `https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions` — full metadata syntax reference
  - If repo has existing `action.yml`: read it first and follow its style

  **Acceptance Criteria**:
  - [ ] `actionlint action.yml` exits 0 with zero errors
  - [ ] `yamllint action.yml` exits 0 with zero warnings
  - [ ] All 13 inputs documented with description text
  - [ ] All 3 outputs defined and reference correct step IDs
  - [ ] `runs.using` is `composite` (not `node20` or `docker`)

  **QA Scenarios**:

  ```
  Scenario: actionlint validation passes
    Tool: Bash
    Preconditions: actionlint installed (brew install actionlint or go install)
    Steps:
      1. Run: actionlint action.yml
      2. Check exit code: echo $?
    Expected Result: exit code 0, zero lines of output
    Failure Indicators: Any line containing "error:" in stdout
    Evidence: .sisyphus/evidence/task-1-actionlint.txt

  Scenario: All required inputs present
    Tool: Bash
    Steps:
      1. Run: yq '.inputs | keys' action.yml
      2. Verify output contains: github-token, copilot-token, model, models, prompt, prompt-file, prompts, fusion, fusion-model, post-comment, allowed-tools, min-prompt-length, max-comment-chars
    Expected Result: All 13 input keys present
    Evidence: .sisyphus/evidence/task-1-inputs.txt
  ```

  **Evidence to Capture**:
  - [ ] task-1-actionlint.txt — actionlint stdout+stderr
  - [ ] task-1-inputs.txt — yq keys output

  **Commit**: YES (group with Tasks 2, 3)
  - Message: `feat(action): add action.yml with composite action definition`
  - Files: `action.yml`

---

- [x] 2. `prompts/code-review.md` + `prompts/security-review.md`

  **What to do**:
  - Create `prompts/` directory
  - Create `prompts/code-review.md`:
    - Purpose: General code quality review of PR changes
    - Structure: 3-5 sections — Code Quality, Logic & Correctness, Maintainability, Performance (if relevant), Summary
    - Ask Copilot to: review `git diff origin/${{ github.base_ref }}...HEAD`, identify bugs, anti-patterns, naming issues, missing edge cases
    - Instruct format: use markdown with `###` headers, bullet points; be concise; prioritize severity (🔴 critical, 🟡 suggestion, 🟢 minor)
    - Instruct: "If no significant issues found, say so explicitly rather than inventing feedback"
    - Instruct: begin with `git log --oneline origin/${{ github.base_ref }}...HEAD` to understand commit context
  - Create `prompts/security-review.md`:
    - Purpose: Security-focused review
    - Ask Copilot to: check for injection vulnerabilities, secret exposure, auth/authz issues, insecure defaults, unsafe deserialization, dependency versions with known CVEs
    - Instruct: use `git diff origin/${{ github.base_ref }}...HEAD` scoped to security-sensitive patterns
    - Format: same severity icons; include OWASP category where applicable
    - Instruct: "If no security concerns found, confirm this explicitly"

  **Must NOT do**:
  - Do NOT add verbose preambles or excessive meta-instructions that inflate token count
  - Do NOT instruct Copilot to use tools beyond `shell(git:*)` (callers control `allowed-tools`)
  - Do NOT hardcode branch names — prompts are templates; use `$GITHUB_BASE_REF` placeholders or instruct use of `git diff origin/HEAD~1` as fallback

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4)
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - Pattern: look at existing `.github/copilot-instructions.md` in repo if present for tone/style
  - Format guide: `https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference` — what Copilot CLI expects as prompt structure

  **Acceptance Criteria**:
  - [ ] Both files exist: `prompts/code-review.md`, `prompts/security-review.md`
  - [ ] `markdownlint-cli2 prompts/code-review.md prompts/security-review.md` exits 0
  - [ ] Each file > 200 characters (not trivially short)
  - [ ] Each file < 4000 characters (not excessively long; avoids token waste)
  - [ ] Each prompt contains a clear instruction to use `git diff` to see changes

  **QA Scenarios**:

  ```
  Scenario: Prompt files are valid markdown
    Tool: Bash
    Steps:
      1. Run: markdownlint-cli2 prompts/code-review.md prompts/security-review.md
      2. Check exit code: echo $?
    Expected Result: exit code 0, zero lint errors
    Evidence: .sisyphus/evidence/task-2-markdownlint.txt

  Scenario: Prompts contain required git instruction
    Tool: Bash
    Steps:
      1. Run: grep -l "git diff" prompts/code-review.md prompts/security-review.md | wc -l
    Expected Result: output is "2" (both files match)
    Evidence: .sisyphus/evidence/task-2-git-diff-check.txt
  ```

  **Evidence to Capture**:
  - [ ] task-2-markdownlint.txt
  - [ ] task-2-git-diff-check.txt

  **Commit**: YES (group with Task 3)
  - Message: `feat(prompts): add bundled code-review and security-review prompts`
  - Files: `prompts/code-review.md`, `prompts/security-review.md`

---

- [x] 3. `prompts/dependency-review.md` + `prompts/test-coverage.md`

  **What to do**:
  - Create `prompts/dependency-review.md`:
    - Purpose: Review dependency changes (package.json, pom.xml, go.mod, requirements.txt, etc.)
    - Ask Copilot to: identify newly added packages, version bumps, removed dependencies; check for known vulnerability patterns; flag unusual dependency sources (non-registry, forked packages); note license type if detectable
    - Instruct: use `git diff origin/$GITHUB_BASE_REF...HEAD -- '**/package.json' '**/go.mod' '**/requirements*.txt' '**/pom.xml' '**/*.gradle'`
    - Format: table with columns: Package, Change Type (added/upgraded/removed), Notes
  - Create `prompts/test-coverage.md`:
    - Purpose: Review test coverage for the PR changes
    - Ask Copilot to: identify new functions/methods/classes with no corresponding tests, check if existing tests were updated to cover changed behavior, flag test files that test code not in the diff (orphaned test changes)
    - Instruct: use `git diff origin/$GITHUB_BASE_REF...HEAD` and `git diff --name-only` to understand scope
    - Format: bullet list; note files with new code and whether tests exist

  **Must NOT do**:
  - Do NOT instruct Copilot to run `npm audit`, `pip check` or similar (not in tool scope)
  - Do NOT assume any specific test framework — keep prompt language-agnostic

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4)
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - Same as Task 2 — follow same prompt style

  **Acceptance Criteria**:
  - [ ] Both files exist: `prompts/dependency-review.md`, `prompts/test-coverage.md`
  - [ ] `markdownlint-cli2 prompts/dependency-review.md prompts/test-coverage.md` exits 0
  - [ ] Each file > 200 characters, < 4000 characters
  - [ ] `dependency-review.md` mentions at least 3 different dependency file patterns

  **QA Scenarios**:

  ```
  Scenario: Prompt files are valid markdown
    Tool: Bash
    Steps:
      1. Run: markdownlint-cli2 prompts/dependency-review.md prompts/test-coverage.md
      2. Check exit code: echo $?
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-3-markdownlint.txt

  Scenario: Dependency prompt covers multiple ecosystems
    Tool: Bash
    Steps:
      1. Run: grep -c "package.json\|go.mod\|requirements\|pom.xml" prompts/dependency-review.md
    Expected Result: output >= 3
    Evidence: .sisyphus/evidence/task-3-ecosystems.txt
  ```

  **Evidence to Capture**:
  - [ ] task-3-markdownlint.txt
  - [ ] task-3-ecosystems.txt

  **Commit**: YES (group with Task 2)
  - Message: `feat(prompts): add bundled dependency-review and test-coverage prompts`
  - Files: `prompts/dependency-review.md`, `prompts/test-coverage.md`

---

- [x] 4. `scripts/post-comment.sh` — PR comment posting with sentinel permission test

  **What to do**:
  - Create `scripts/post-comment.sh` — executable bash script (add `#!/usr/bin/env bash` + `set -euo pipefail`)
  - Reads env vars: `GH_TOKEN`, `INPUT_POST_COMMENT`, `INPUT_MAX_COMMENT_CHARS`, `REVIEW_FILE` (path to review text), `GITHUB_REPOSITORY`, `PR_NUMBER` (or `GITHUB_REF` to parse)
  - If `INPUT_POST_COMMENT != 'true'`: set output `comment-url=` (empty) and exit 0
  - **Sentinel permission test**:
    1. Attempt to add `eyes` reaction to the PR: `gh api "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/reactions" -f content=eyes --silent`
    2. Capture HTTP status. If 403 or 404: log warning "Insufficient permissions to post PR comment; skipping." Set output `comment-url=` and exit 0
    3. If succeeded: immediately delete the reaction (get reaction ID from response JSON, delete via `gh api --method DELETE`)
    4. Proceed with comment posting
  - **Truncation**: Read `REVIEW_FILE`. If length > `INPUT_MAX_COMMENT_CHARS`:
    - Truncate to `INPUT_MAX_COMMENT_CHARS` characters
    - Append `\n\n---\n*Review truncated at $INPUT_MAX_COMMENT_CHARS characters.*`
  - **Post comment**: `gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --body "$review_text"`
  - **Capture comment URL**: parse from `gh pr comment` output or use `gh pr view --json comments` to find latest comment URL
  - **Set output**: `echo "comment-url=$url" >> "$GITHUB_OUTPUT"`
  - **Error handling**:
    - If `REVIEW_FILE` doesn't exist or is empty: log warning, set `comment-url=`, exit 0 (don't fail the job)
    - If comment posting fails (non-permission error): log error and exit 1

  **Security requirements**:
  - All shell variables interpolated into `gh` commands must be quoted: `"$PR_NUMBER"` not `$PR_NUMBER`
  - Never `eval` any user input
  - The `--body` content comes from a file (not from an input); still use `--body-file` if available or ensure the variable is properly quoted

  **Must NOT do**:
  - Do NOT use `--body "$(cat file)"` if the file content could contain shell metacharacters — use `--body-file "$REVIEW_FILE"` instead (check `gh pr comment` supports `--body-file`)
  - Do NOT fail the CI job on comment permission errors (graceful skip)
  - Do NOT log the review text to stdout (could expose code/secrets in CI logs)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: none
  - **Reason**: Requires careful shell scripting with error handling, permission detection, and GitHub API calls

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3)
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - `gh pr comment --help` — verify `--body-file` flag availability
  - `gh api repos/{owner}/{repo}/issues/{issue_number}/reactions` — GitHub REST API for reactions
  - Pattern: `https://docs.github.com/en/rest/reactions/reactions` — Reaction API reference
  - `https://cli.github.com/manual/gh_pr_comment` — `gh pr comment` flags

  **Acceptance Criteria**:
  - [ ] `shellcheck scripts/post-comment.sh` exits 0 (zero errors or warnings)
  - [ ] `bash -n scripts/post-comment.sh` exits 0 (valid syntax)
  - [ ] Script uses `--body-file` (not `--body "$(cat...)"`) for comment text
  - [ ] Sentinel test: reaction is created then deleted (net zero side effects)
  - [ ] On 403 from sentinel test: script exits 0 (not 1)
  - [ ] On empty/missing `REVIEW_FILE`: script exits 0 with warning message

  **QA Scenarios**:

  ```
  Scenario: shellcheck passes
    Tool: Bash
    Steps:
      1. Run: shellcheck scripts/post-comment.sh
      2. Check exit code: echo $?
    Expected Result: exit code 0, zero output
    Evidence: .sisyphus/evidence/task-4-shellcheck.txt

  Scenario: POST_COMMENT=false exits cleanly without any API calls
    Tool: Bash
    Steps:
      1. Set env: INPUT_POST_COMMENT=false GITHUB_OUTPUT=/dev/null REVIEW_FILE=/dev/null
      2. Run: bash scripts/post-comment.sh
      3. Check exit code: echo $?
    Expected Result: exit code 0, no "api" or "gh" calls made
    Evidence: .sisyphus/evidence/task-4-no-post.txt

  Scenario: Missing REVIEW_FILE exits 0 with warning
    Tool: Bash
    Steps:
      1. Set env: INPUT_POST_COMMENT=true REVIEW_FILE=/nonexistent/file.md GITHUB_OUTPUT=/tmp/out.txt
      2. Run: bash scripts/post-comment.sh 2>&1 | head -5
      3. Check exit code: echo $?
    Expected Result: exit code 0, stderr/stdout contains "warning" or "skip"
    Evidence: .sisyphus/evidence/task-4-missing-file.txt
  ```

  **Evidence to Capture**:
  - [ ] task-4-shellcheck.txt
  - [ ] task-4-no-post.txt
  - [ ] task-4-missing-file.txt

  **Commit**: YES (separate commit)
  - Message: `feat(scripts): add post-comment.sh with sentinel permission test`
  - Files: `scripts/post-comment.sh`
  - Pre-commit: `shellcheck scripts/post-comment.sh`

---

- [ ] 5. `scripts/run-reviews.sh` — Main orchestration

  **What to do**:
  - Create `scripts/run-reviews.sh` — executable bash script (`#!/usr/bin/env bash`, `set -euo pipefail`)
  - **Reads env vars from action.yml step env** (all prefixed `INPUT_`):
    - `INPUT_MODEL`, `INPUT_MODELS`, `INPUT_PROMPT`, `INPUT_PROMPT_FILE`, `INPUT_PROMPTS`
    - `INPUT_FUSION`, `INPUT_FUSION_MODEL`, `INPUT_ALLOWED_TOOLS`
    - `INPUT_MIN_PROMPT_LENGTH`, `COPILOT_AUTO_UPDATE` (always `false`)
    - `GITHUB_ACTION_PATH` (path to action root), `GITHUB_BASE_REF`, `GITHUB_REPOSITORY`, `GITHUB_REF`
  - **Step 1 — Verify Copilot CLI available**:
    - `copilot --version` or `copilot help` — if not found, exit 1 with clear message "copilot CLI not found; ensure npm install step ran before this script"
    - Check if `--no-custom-instructions` flag is supported: `copilot help 2>&1 | grep -q 'no-custom-instructions'`. If yes, set `NO_CUSTOM_INSTRUCTIONS_FLAG='--no-custom-instructions'`; if no, set to `''` and log warning "WARNING: --no-custom-instructions flag not found; AGENTS.md injection protection is unavailable"
  - **Step 2 — Resolve models list**:
    - If `INPUT_MODELS` is non-empty: split by comma → `MODELS_LIST`
    - Else: use `INPUT_MODEL` → `MODELS_LIST`
    - Validate list is non-empty; exit 1 if both are empty
  - **Step 3 — Resolve prompts list**:
    - `PROMPT_FILES=()` array
    - If `INPUT_PROMPT` is non-empty: write to temp file; append path to array
    - Elif `INPUT_PROMPT_FILE` is non-empty: validate file exists (within `$GITHUB_WORKSPACE`); append to array
    - If `INPUT_PROMPTS` is non-empty: split by comma; for each name, resolve to `$GITHUB_ACTION_PATH/prompts/${name}.md`; validate file exists; append to array
    - If `PROMPT_FILES` is empty: default to `$GITHUB_ACTION_PATH/prompts/code-review.md`
  - **Step 4 — Get PR diff and check min length**:
    - `PR_DIFF=$(git diff "origin/$GITHUB_BASE_REF...HEAD")` (handle fetch-depth check)
    - If `${#PR_DIFF} < INPUT_MIN_PROMPT_LENGTH`: log "PR diff is smaller than min-prompt-length (${#PR_DIFF} < $INPUT_MIN_PROMPT_LENGTH); skipping review" and exit 0 with empty outputs
  - **Step 5 — Run reviews (nested loop)**:
    - For each prompt file in `PROMPT_FILES`:
      - For each model in `MODELS_LIST`:
        - Generate output filename: `review_${model//\//-}_${prompt_slug}.md`
        - Set `NO_CUSTOM_FLAG` if supported
        - Run: `COPILOT_AUTO_UPDATE=false copilot -p "$(cat "$prompt_file")" -s --no-ask-user --allow-tool="${INPUT_ALLOWED_TOOLS}" --model "$model" $NO_CUSTOM_FLAG > "$output_file"`
        - On success: append model to `SUCCEEDED_MODELS` list
        - On failure: log warning "Review failed for model=$model prompt=$prompt_slug"; continue (don't fail job)
    - Track `LAST_REVIEW_FILE` = path to last successful output
  - **Step 6 — Fusion (if enabled)**:
    - If `INPUT_FUSION == 'true'` and `${#SUCCEEDED_MODELS[@]} > 0`:
      - Build fusion prompt: concatenate all successful review files into a single prompt asking Copilot to synthesize into a single coherent review, deduplicate findings, and prioritize by severity
      - Determine fusion model: `INPUT_FUSION_MODEL` if non-empty, else first model in `MODELS_LIST`
      - Run fusion: `COPILOT_AUTO_UPDATE=false copilot -p "$(cat "$fusion_prompt_file")" -s --no-ask-user --allow-tool='shell(git:*)' --model "$fusion_model" $NO_CUSTOM_FLAG > "$fusion_output"`
      - Set `LAST_REVIEW_FILE=$fusion_output`
  - **Step 7 — Set outputs**:
    - `echo "review=$(cat "$LAST_REVIEW_FILE")" >> "$GITHUB_OUTPUT"` — but review may be multi-line; use `EOF` heredoc syntax for multi-line GITHUB_OUTPUT
    - `echo "models-used=$(IFS=','; echo "${SUCCEEDED_MODELS[*]}")" >> "$GITHUB_OUTPUT"`
    - Export `REVIEW_FILE="$LAST_REVIEW_FILE"` for `post-comment.sh` (or write path to a known location)

  **Security requirements**:
  - `INPUT_ALLOWED_TOOLS` must be validated/escaped before use: use `printf '%q' "$INPUT_ALLOWED_TOOLS"` or pass via env var, NOT direct interpolation
  - All file paths validated against `$GITHUB_WORKSPACE` prefix (no path traversal)
  - `prompt-file` must be within workspace: `[[ "$resolved_path" == "$GITHUB_WORKSPACE"* ]]`
  - NEVER `eval` any input
  - Temp files created with `mktemp` (not hardcoded paths)

  **Must NOT do**:
  - Do NOT put `2>&1` on the `copilot` command (pollutes review with stderr)
  - Do NOT set `COPILOT_AUTO_UPDATE` to anything other than `false`
  - Do NOT allow `INPUT_ALLOWED_TOOLS` to be passed unquoted to shell

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: none
  - **Reason**: Complex orchestration with multiple error paths, security requirements, and multi-line GitHub output handling

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential, after Wave 1)
  - **Blocks**: Tasks 6, 7
  - **Blocked By**: Tasks 1, 2, 3, 4

  **References**:
  - `action.yml` — read first to understand exact env var names and input names
  - `scripts/post-comment.sh` — read to understand what `REVIEW_FILE` env var it expects
  - `prompts/` directory — read to understand available prompt files and their names
  - `https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#multiline-strings` — multi-line GITHUB_OUTPUT heredoc syntax
  - `https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference` — confirmed CLI flags

  **Acceptance Criteria**:
  - [ ] `shellcheck scripts/run-reviews.sh` exits 0
  - [ ] `bash -n scripts/run-reviews.sh` exits 0
  - [ ] `COPILOT_AUTO_UPDATE=false` is set in ALL copilot invocations (grep confirms)
  - [ ] `--no-ask-user` present in all copilot invocations
  - [ ] `--model` is always passed (never omitted)
  - [ ] `INPUT_ALLOWED_TOOLS` is NOT directly interpolated without quoting in copilot call
  - [ ] Fusion output replaces individual reviews in the `review` output when `INPUT_FUSION=true`
  - [ ] When all models fail: script exits 0 with warning (does not fail the CI job)

  **QA Scenarios**:

  ```
  Scenario: shellcheck passes
    Tool: Bash
    Steps:
      1. Run: shellcheck scripts/run-reviews.sh
      2. Check: echo $?
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-5-shellcheck.txt

  Scenario: COPILOT_AUTO_UPDATE is always false
    Tool: Bash
    Steps:
      1. Run: grep -n "COPILOT_AUTO_UPDATE" scripts/run-reviews.sh
      2. Verify: every copilot invocation line has COPILOT_AUTO_UPDATE=false preceding it
      3. Run: grep -c "copilot -p" scripts/run-reviews.sh (count invocations)
      4. Run: grep -c "COPILOT_AUTO_UPDATE=false.*copilot\|COPILOT_AUTO_UPDATE=false" scripts/run-reviews.sh
    Expected Result: COPILOT_AUTO_UPDATE=false count >= copilot invocation count
    Evidence: .sisyphus/evidence/task-5-auto-update.txt

  Scenario: Path traversal blocked for prompt-file
    Tool: Bash
    Steps:
      1. Set env: INPUT_PROMPT_FILE='../../etc/passwd' GITHUB_WORKSPACE=/tmp/workspace
      2. Run: bash scripts/run-reviews.sh 2>&1
      3. Check: output contains "outside workspace" or similar error
      4. Check: exit code is 1 (not 0)
    Expected Result: script exits 1 with path validation error
    Evidence: .sisyphus/evidence/task-5-path-traversal.txt
  ```

  **Evidence to Capture**:
  - [ ] task-5-shellcheck.txt
  - [ ] task-5-auto-update.txt
  - [ ] task-5-path-traversal.txt

  **Commit**: YES (separate commit)
  - Message: `feat(scripts): add run-reviews.sh orchestration with security controls`
  - Files: `scripts/run-reviews.sh`
  - Pre-commit: `shellcheck scripts/run-reviews.sh`

---

- [ ] 6. `README.md` — Marketplace-quality documentation

  **What to do**:
  - Write `README.md` targeting GitHub Marketplace standards
  - **Sections**:
    1. **Title + badges**: repo name, CI badge, Marketplace badge
    2. **Overview**: 2-3 sentences — what the action does, why use it
    3. **Prerequisites** (MANDATORY section — must be prominent):
       - `actions/checkout` with `fetch-depth: 0` is required (shallow clones break `git diff`)
       - Fine-grained PAT with "Copilot Requests" permission required for `copilot-token` (classic PATs not supported)
       - The acting user must have an active GitHub Copilot subscription
    4. **Quick Start**: minimal working example (copy-pasteable workflow YAML)
    5. **Inputs** table: all 13 inputs, type, required/optional, default, description
    6. **Outputs** table: all 3 outputs, description, when populated
    7. **Examples**:
       - Single model, default code review
       - Multiple models
       - Custom prompt file
       - Fusion mode
       - All built-in prompts
    8. **Security Considerations**:
       - `allowed-tools` warning: expanding beyond `shell(git:*)` grants CI environment access
       - `pull_request` vs `pull_request_target`: explain why `pull_request_target` must NOT be used with this action
       - AGENTS.md injection: if `--no-custom-instructions` is not available in the CLI version, any `.copilot/instructions.md` in the repo affects review behavior
       - Fork PRs: Copilot reviews work on fork PRs with `pull_request` trigger because `copilot-token` is the reviewing credential (not `GITHUB_TOKEN`); however, comment posting may fail if `GITHUB_TOKEN` lacks write permissions on fork PRs
    9. **Troubleshooting**: common errors with solutions
       - "Copilot CLI not found": npm install step not configured correctly
       - "403 on comment post": GITHUB_TOKEN lacks `pull-requests: write`
       - "Empty review output": check `min-prompt-length` vs actual diff size
    10. **License**: MIT (or repo license)

  **Must NOT do**:
  - Do NOT pad with excessive badges or trophy sections
  - Do NOT claim the action supports features it doesn't (no inline comments, no approvals)
  - Do NOT recommend `pull_request_target` anywhere

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: [`markdown-editor`]
  - **Reason**: Documentation task; markdown-editor skill provides formatting guidance

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 7)
  - **Parallel Group**: Wave 3
  - **Blocks**: Final QA
  - **Blocked By**: Task 5 (need to know final input/output names)

  **References**:
  - `action.yml` — read first; all input/output names and defaults come from here
  - `scripts/run-reviews.sh` — read to document prerequisites (fetch-depth, etc.)
  - Example marketplace READMEs: `actions/checkout`, `actions/setup-node` for formatting standards

  **Acceptance Criteria**:
  - [ ] `markdownlint-cli2 README.md` exits 0
  - [ ] All 13 inputs documented in an inputs table
  - [ ] "Prerequisites" section prominently visible (before Examples)
  - [ ] `fetch-depth: 0` mentioned at least once
  - [ ] "fine-grained PAT" mentioned (not just "PAT" or "token")
  - [ ] Security section present with `pull_request_target` warning
  - [ ] At least 4 distinct usage examples

  **QA Scenarios**:

  ```
  Scenario: markdownlint passes
    Tool: Bash
    Steps:
      1. Run: markdownlint-cli2 README.md
      2. Check: echo $?
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-6-markdownlint.txt

  Scenario: All required sections present
    Tool: Bash
    Steps:
      1. Run: grep -c "^## " README.md
      2. Verify count >= 8
      3. Run: grep -l "Prerequisites\|fetch-depth\|fine-grained" README.md
    Expected Result: file matches all three terms
    Evidence: .sisyphus/evidence/task-6-sections.txt
  ```

  **Evidence to Capture**:
  - [ ] task-6-markdownlint.txt
  - [ ] task-6-sections.txt

  **Commit**: YES
  - Message: `docs: add marketplace-quality README with prerequisites and security guide`
  - Files: `README.md`

---

- [ ] 7. `.github/workflows/example-copilot-review.yml` — Example consumer workflow

  **What to do**:
  - Create `.github/workflows/example-copilot-review.yml`
  - **Trigger**: `on: pull_request: types: [opened, synchronize, reopened]` — NOT `pull_request_target`
  - **Permissions** block:
    ```yaml
    permissions:
      contents: read
      pull-requests: write
    ```
  - **Job**: `copilot-review` running on `ubuntu-latest`
  - **Steps**:
    1. `actions/checkout@v4` with `fetch-depth: 0`
    2. `./` (this action) with:
       - `github-token: ${{ secrets.GITHUB_TOKEN }}`
       - `copilot-token: ${{ secrets.COPILOT_TOKEN }}`
       - `model: claude-sonnet-4.6`
       - `prompts: code-review,security-review`
       - `post-comment: true`
  - Add comment in YAML explaining `COPILOT_TOKEN` must be a fine-grained PAT with "Copilot Requests" permission
  - Add a `# Note:` comment that `pull_request_target` must NOT be substituted for `pull_request` (security risk)

  **Must NOT do**:
  - Do NOT use `pull_request_target`
  - Do NOT hardcode any token values
  - Do NOT set `fetch-depth: 1` (must be `0` for full git history)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`github-actions`]
  - **Reason**: YAML workflow file; github-actions skill provides syntax guidance

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 6)
  - **Parallel Group**: Wave 3
  - **Blocks**: Final QA
  - **Blocked By**: Task 5

  **References**:
  - `action.yml` — read to get correct input names
  - `https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#understanding-the-risk-of-script-injections` — why not pull_request_target

  **Acceptance Criteria**:
  - [ ] `actionlint .github/workflows/example-copilot-review.yml` exits 0
  - [ ] `on:` contains `pull_request` (not `pull_request_target`)
  - [ ] `fetch-depth: 0` present in checkout step
  - [ ] `permissions: pull-requests: write` present
  - [ ] Both `github-token` and `copilot-token` use secrets references (not hardcoded)

  **QA Scenarios**:

  ```
  Scenario: actionlint passes
    Tool: Bash
    Steps:
      1. Run: actionlint .github/workflows/example-copilot-review.yml
      2. Check: echo $?
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-7-actionlint.txt

  Scenario: Security checks
    Tool: Bash
    Steps:
      1. Run: grep "pull_request_target" .github/workflows/example-copilot-review.yml
      2. Expect: no output (grep returns 1, i.e., NOT FOUND is the success condition)
      3. Run: grep "fetch-depth: 0" .github/workflows/example-copilot-review.yml
      4. Expect: match found
    Expected Result: no pull_request_target, fetch-depth: 0 present
    Evidence: .sisyphus/evidence/task-7-security.txt
  ```

  **Evidence to Capture**:
  - [ ] task-7-actionlint.txt
  - [ ] task-7-security.txt

  **Commit**: YES
  - Message: `ci: add example workflow for copilot-review action`
  - Files: `.github/workflows/example-copilot-review.yml`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read `action.yml`, both scripts, all 4 prompts, `README.md`, and example workflow. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns (especially `2>&1` on copilot output, `pull_request_target`, `@latest` in npm install, unquoted `$INPUT_ALLOWED_TOOLS`). Check evidence files exist in `.sisyphus/evidence/`.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `shellcheck scripts/*.sh`, `actionlint action.yml`, `actionlint .github/workflows/example-copilot-review.yml`, `markdownlint-cli2 README.md prompts/*.md`. Check scripts for: `set -euo pipefail`, proper quoting, no `eval`, `mktemp` for temp files, heredoc for multi-line GITHUB_OUTPUT. Flag AI-generated anti-patterns: over-commenting, redundant checks, unused variables.
  Output: `shellcheck [PASS/FAIL] | actionlint [PASS/FAIL] | markdownlint [PASS/FAIL] | VERDICT`

- [ ] F3. **Real Integration QA** — `unspecified-high`
  On a real PR in this repo (or create a test PR):
  1. Create a feature branch with a small code change
  2. Open a PR against main
  3. Manually trigger the action (or push to trigger the workflow)
  4. Verify review appears as PR comment
  5. Verify comment-url output is populated
  6. Verify models-used output is correct
  Save screenshots/command output to `.sisyphus/evidence/final-qa/`.
  Output: `Integration [PASS/FAIL] | Comment posted [YES/NO] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", check actual file content. Verify nothing beyond spec was added. Check for: inline PR comments code (forbidden), approval/label mutation code (forbidden), `pull_request_target` anywhere (forbidden), `@latest` in npm install (forbidden), hardcoded model lists (forbidden). Flag any unaccounted files created.
  Output: `Tasks [N/N compliant] | Forbidden patterns [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

| Commit | Files | Message |
|--------|-------|---------|
| 1 | `action.yml`, `prompts/code-review.md`, `prompts/security-review.md`, `prompts/dependency-review.md`, `prompts/test-coverage.md` | `feat(action): add action.yml and bundled review prompts` |
| 2 | `scripts/post-comment.sh` | `feat(scripts): add post-comment.sh with sentinel permission test` |
| 3 | `scripts/run-reviews.sh` | `feat(scripts): add run-reviews.sh orchestration with security controls` |
| 4 | `README.md` | `docs: add marketplace-quality README with prerequisites and security guide` |
| 5 | `.github/workflows/example-copilot-review.yml` | `ci: add example workflow for copilot-review action` |

---

## Success Criteria

### Verification Commands
```bash
actionlint action.yml                           # Expected: exit 0, zero output
shellcheck scripts/run-reviews.sh               # Expected: exit 0
shellcheck scripts/post-comment.sh              # Expected: exit 0
markdownlint-cli2 README.md prompts/*.md        # Expected: exit 0
actionlint .github/workflows/*.yml              # Expected: exit 0
grep -rn "2>&1" scripts/ | grep "copilot"       # Expected: no matches (exit 1)
grep -rn "pull_request_target" .github/         # Expected: no matches (exit 1)
grep -rn "@latest" action.yml scripts/          # Expected: no matches (exit 1)
```

### Final Checklist
- [ ] All "Must Have" present (13 items)
- [ ] All "Must NOT Have" absent (12 items)
- [ ] `shellcheck`, `actionlint`, `markdownlint-cli2` all pass
- [ ] Integration test posts a real PR comment
- [ ] `COPILOT_AUTO_UPDATE=false` present in every copilot CLI invocation
- [ ] `--no-ask-user` present in every copilot CLI invocation
- [ ] Fine-grained PAT requirement documented (README + action.yml input description)
