- `actionlint action.yml` treats the file as a workflow, so the raw output is noisy for action metadata.
- `yamllint` was not initially installed in the environment; required a user-site pip install with `--break-system-packages`.
- `shellcheck` was not installed in the local environment, so Task 5 verification used the `koalaman/shellcheck:stable` Docker image to capture a clean exit code.

## [2026-04-27] F3 Real Integration QA — BLOCKED

**Blocker**: `COPILOT_TOKEN` secret not configured in `jander99/copilot-action` repo.

**What's needed**:
1. Go to: https://github.com/jander99/copilot-action/settings/secrets/actions
2. Create secret: `COPILOT_TOKEN`
3. Value: a **fine-grained PAT** (NOT classic `ghp_`) with the **"Copilot Requests"** permission
4. Once set, re-run the workflow on PR #1 or push a new commit to trigger it

**PR created**: https://github.com/jander99/copilot-action/pull/1
The example workflow (`example-copilot-review.yml`) will trigger on the PR using `uses: ./`.
