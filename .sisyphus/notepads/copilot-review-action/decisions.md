# Decisions

## 2026-04-27 Bootstrap

- Use Copilot CLI (not GitHub Models REST API)
- Permission detection: sentinel write test (add+delete `eyes` reaction, 403 = no write, graceful skip)
- PR comment error handling: keep spec approach but fix detection method
- post-comment.sh creates new comment each run (not update-existing)
- Only `pull_request` trigger in example workflow (NOT `pull_request_target`)
- `GITHUB_PR_NUMBER` passed as env var from action.yml
- `models` input takes precedence over `model` when both set (warn and ignore `model`)
- `prompt` (inline) takes precedence over `prompt-file` when both set
- Invalid model → action exits with clear error listing valid models
- Zero changed files → exit 0 with warning, no review posted
- npm pin to 1.0.37 (not @latest)
