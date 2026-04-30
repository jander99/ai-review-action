# Dependency review

Review the dependency changes in this pull request.

Run:

```bash
git diff origin/$GITHUB_BASE_REF...HEAD \
  -- '**/package.json' '**/go.mod' '**/requirements*.txt' \
  '**/pom.xml' '**/*.gradle' '**/*.lock'
```

Then identify:

- newly added packages
- version bumps
- removed dependencies
- dependencies from unusual sources such as non-registry URLs,
  forked packages, or git URLs
- dependencies without explicit version pins
- license type if it is visible in the file

If there are no dependency changes, say so clearly.

Output format:

| Package | Change Type (added/upgraded/removed/pinned) | Notes |
| --- | --- | --- |
| ... | ... | ... |

Keep the review concise and focused on dependency risk.
