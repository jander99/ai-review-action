Review the changes in this pull request and produce a single markdown review.

Output contract (the comment is posted verbatim to the PR):

- Begin the response with a single top-level heading of the form
  `# PR #N Review — <short title>` (use the PR number and title from the
  runtime context). No greeting, no preamble, no plan, no
  "I'll start by..." narration.
- Use the severity legend in your agent prompt for findings. Keep findings
  concrete: cite file paths and line numbers from the diff or the
  repository.
- Do not emit reasoning traces, tool-call XML, or any other model-internal
  markup in the final review. Tool use is for evidence gathering only and
  must not appear in the output body.
- If you find no issues, say exactly `No issues found.` after the heading
  and stop. Do not invent findings to look thorough.
- Do not use code fences for the review body unless quoting source. The
  comment truncates at the configured character limit; keep the review
  dense.
