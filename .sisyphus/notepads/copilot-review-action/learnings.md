# Learnings

## 2026-04-27 Bootstrap

### CLI invocation (VERIFIED from official docs)
```bash
copilot -p "$(cat prompt.md)" -s --no-ask-user --allow-tool='shell(git:*)' --model "$model"
```
- `-s` = silent mode (suppresses stats, clean stdout)
- `-p` = prompt (NOT `-sp`, flags are separate)
- `--no-ask-user` = non-interactive (REAL flag, confirmed in docs)
- `--model` = model selector
- `--allow-tool='shell(git:*)'` = restrict shell to git commands

### Auth token precedence (VERIFIED)
`COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN`

### Correct npm pin
```bash
npm install -g @github/copilot@1.0.37
```

### Security musts
- `COPILOT_AUTO_UPDATE=false` in every copilot invocation
- `--no-custom-instructions` flag (verify at runtime; fallback: log warning)
- NO `2>&1` on copilot output (stderr must remain separate)
- `--body-file` NOT `--body "$(cat ...)"` for gh pr comment

### Sentinel permission detection
Add `eyes` reaction to PR → delete it → 403 = no write access → graceful skip

### Token requirement
Must be fine-grained PAT with "Copilot Requests" permission (classic PATs explicitly NOT supported per official docs)

### Prompt templates
- Keep review prompts concise and markdownlint-clean with explicit `git log` and `git diff` instructions.
- Use top-level headings and short sections so the prompt stays readable and under the size limit.
