# Ledger — decision-review pipeline

Plan: `docs/superpowers/plans/2026-11-19-decision-review-pipeline.md`
Part 6 / PR 6 — remove the harness runtimes; v2. Worktree: `.worktrees/drp-6`, branch `feat/decision-review-6` off `origin/main` (a83fdc2).

## Task 22: Delete OpenCode/Claude runtimes, setup-opencode, validate-review; docs; major version

- [x] Created worktree from origin/main
- [ ] Step 1: failing test in packages/root-action/test/inputs.test.cjs (no `opencode`, `--allowedTools`, `validateReview` in either bundle)
- [ ] Step 2: confirm RED
- [ ] Step 3: delete and update
- [ ] Step 4: full verification
- [ ] Step 5: commit, push, open PR 6
- [ ] Step 6: gate the release on the stability study + e2e measure

## Notes

- Known drift to fix here: `release.yml` tracked-dist list vs `ci.yml`.
- Part 5 taught a pattern worth carrying: stale export/input lists in ci.yml and smoke.yml are the most common CI breakage after an API change. Check both for every removed export.
