# SDD ledger — plan: docs/superpowers/plans/2026-11-19-decision-review-pipeline.md

Part 3 — PR 3: the pipeline (Tasks 11-19). Worktree `.worktrees/drp-3`, branch `feat/decision-review-3-pipeline` off origin/main c40fd87.
Pre-flight: Task 12 consumes `fence`/`estimateTokens` from itself; Tasks 13-19 consume review-contract's `FINDINGS_JSON_SCHEMA`, `parseUnifiedDiff`, `findAnchorHunk` from Task 11 — additive, no conflict. Parts 1-2 are merged, so every Consumes interface is on main.
