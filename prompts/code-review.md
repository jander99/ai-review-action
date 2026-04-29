# Code Review Prompt

## Review Focus

You are reviewing this pull request for general code quality.

First, inspect commit context:

- Run `git log --oneline origin/$GITHUB_BASE_REF...HEAD`
- Run `git diff origin/$GITHUB_BASE_REF...HEAD`

Review the changes for:

- Bugs
- Anti-patterns
- Naming issues
- Missing edge cases
- Logic errors

### Code Quality

- 🔴 Critical bug
- 🟡 Suggestion
- 🟢 Minor nit

### Logic & Correctness

- 🔴 Critical bug
- 🟡 Suggestion
- 🟢 Minor nit

### Maintainability

- 🔴 Critical bug
- 🟡 Suggestion
- 🟢 Minor nit

### Performance

- Include only if relevant.
- 🔴 Critical bug
- 🟡 Suggestion
- 🟢 Minor nit

### Summary

- If no significant issues are found, say so explicitly rather than inventing feedback.
- Keep the response concise and avoid verbose preambles or meta-instructions.
