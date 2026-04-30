# Test coverage review

Review test coverage for the changed code.

Run:

```bash
git diff origin/$GITHUB_BASE_REF...HEAD
```

Then run:

```bash
git diff --name-only origin/$GITHUB_BASE_REF...HEAD
```

Use those diffs to identify:

- new functions, methods, or classes with no corresponding tests
- existing tests that were updated to cover changed behavior
- test files that appear to cover code not in the diff
- orphaned test changes that do not map to changed production code

This review is language-agnostic and must not assume any specific test framework.

Output format:

- list changed files with new code and whether corresponding tests exist
- note missing test coverage clearly
- note orphaned test changes clearly
- if all changed code appears to have corresponding test coverage, say so explicitly

Keep the review concise and actionable.
