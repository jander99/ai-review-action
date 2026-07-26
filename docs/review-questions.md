# Open Review Questions

> Status: **fully resolved** — all 8 design questions answered, all
> decisions baked into `design-vision.md`. This document is preserved as
> a historical record of the review process and decisions made.
>
> Tier 1-3 quiz: 13 decisions resolved (see early history).
> Tier 4-5 quiz: 8 decisions resolved (this file).
> Implementation tracker: D12 (contract tests) — not a design question.

## Decisions log (chronological)

### Tier 1-3 (13 decisions)

| # | Question | Decision |
|---|---|---|
| C2 (#12) | AI_REVIEW_SYSTEM_PROMPT inspectability | Drop the promise |
| D2 (#3) | Example structure | Quickstart + runnable features |
| D14 (#28) | Section order | Move prereqs + quickstart to front |
| A3 (#14) | Permission defaults | Explicit per-tool (read/glob/grep/list/webfetch allow; edit/question/doom_loop ask; bash allow) |
| A4 (#16) | Explicit `permissions:` block | Show examples with AND without |
| D3 (#4) | OpenCode install ownership | Workflow installs; action asserts version |
| D7 (#20) | `prompts` syntax | `file:` / `text:` prefix |
| D6 (#1) | `comment-url` ownership | `post-comment` owns it |
| D5 (#6) | Checkout enforcement | Document + strict assert |
| D4 (#5) | Diff vs full target | DROP `diff` as a concept — model decides |
| D11 (#25) | Platform support | Linux only |
| D8 (#21) | Result ordering | Stable lexical |
| A5 (#24) | Debug redaction | Opt-in + redact known patterns |

### Tier 4-5 (8 decisions)

| # | Question | Decision |
|---|---|---|
| A1 (#17, #15) | Trust model for agent execution | Delete on-disk `opencode.json`/`.jsonc` before running |
| C1 (#11) | Privileged instructions location | Agent definition in merged config (privileged); prompt is the task |
| B1 (#7, #8, #9) | Config builder architecture | Temp + rebase user config paths + HOME isolation |
| B2 (#18) | Built-in provider registry | Comprehensive: MiniMax + Kimi + AWS Bedrock + Google Vertex |
| D1 (#2) | Default-branch push destination | Check run (`ai-review` named check) |
| D2 (#22) | Fusion prompt contract | Default: model+prompt labels, 50k/review size limit, sanitized input, no tools, cost included |
| D3 (#23) | Partial results | Post what's available; `fail-on-error` controls exit code |
| D4 (#27) | Supply-chain pinning | Composite step (`setup-opencode`) with pinned version + checksum |

## Implementation tracker

| # | Item | Type |
|---|---|---|
| D12 (#26) | Contract tests for verified ABI | Implementation work — each "verified in 1.18.4" claim needs a pinned test fixture |

## Composition of the final action

The action's surface, after all decisions:

- **Composite step `setup-opencode`** — downloads OpenCode with checksum
- **Pre-run cleanup** — deletes on-disk `opencode.json`/`.jsonc` from working directory
- **Config builder** — reads user config, rebases paths, merges required settings (permission, agent, model, built-in providers), writes to `$RUNNER_TEMP`, sets `HOME` to temp dir, validates against `$schema`
- **Agent definition** — privileges the action's instructions in the merged config
- **Prompt composition** — task prompt only (user-provided); privileged instructions in agent definition
- **Multi-model / multi-prompt loop** — stable lexical order, cross-product of `models × prompts`
- **Fusion** — when enabled, labels, sanitized input, no tools, cost included
- **Result posting** — partial results on failure; PR comment for `pull_request`, check run for other events
- **Outputs** — `review`, `models-used`, `cost`, `cost-by-model`, `tokens`, `tokens-by-model`, `comment-url` / `check-run-url`
- **Debug mode** — opt-in, redact known patterns, upload as artifact

The design is complete. Next steps are implementation.
