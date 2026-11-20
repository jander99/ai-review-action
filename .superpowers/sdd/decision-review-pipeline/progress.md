# SDD ledger — plan: docs/superpowers/plans/2026-11-19-decision-review-pipeline.md

Part 5 — PR 5: wire the action to the pipeline (Tasks 19-21). Worktree `.worktrees/drp-5`, branch `feat/decision-review-5` off origin/main f8d3cdf.
Pre-flight: Task 19 consumes runReviewPipeline (Part 3), createLlmClient/createDecisionClient (Part 2), fetchPriorReviews + parsePriorFindings (Part 4) — all on main. Task 20 consumes postReview (Part 4) and runReviews (Task 19). Task 21 extends the study CLI from Part 1. Handoffs are sequential within the part.
Task 19 also depends on readBaseInstructions trimming: the plan says `git show <sha>:<path>` but the test requires the base rules to fit the context; trimming is done by the context builder.
