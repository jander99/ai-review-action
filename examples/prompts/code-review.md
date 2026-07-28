Review the changes in this pull request and produce a single markdown review.

Output contract (the comment is posted verbatim to the PR):

- Your response body MUST begin with a single top-level heading of the form
  `# PR #N Review — <short title>` (use the PR number and title from the
  runtime context). No greeting, no preamble, no plan, no
  "I'll start by..." narration.
- The parser uses that heading as a hard delimiter: everything emitted
  before it — reasoning, tool calls, planning narration, verification
  steps, the title you considered and discarded — is treated as internal
  scratch and discarded. Anything you want kept in the final comment must
  appear on or after the heading line.
- Use the severity legend in your agent prompt for findings. Keep findings
  concrete: cite file paths and line numbers from the diff or the
  repository.
- Do not emit reasoning traces, tool-call XML, or any other model-internal
  markup in the final review. Tool use is for evidence gathering only and
  must not appear in the output body.
- If you find no issues, emit exactly the heading followed by
  `No issues found.` and stop. Do not invent findings to look thorough.
- Do not use code fences for the review body unless quoting source. The
  comment truncates at the configured character limit; keep the review
  dense.
