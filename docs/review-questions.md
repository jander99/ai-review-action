# Open Review Questions

> Source: fresh-eyes review of `design-vision.md` by an independent reviewer
> with no design-phase context. 28 findings; 11 blockers. Grouped here into
> four themes and reframed as questions to resolve. Numbering preserved from
> the original review for traceability.
>
> One finding (#13) was re-tested against the pinned binary (OpenCode 1.18.4)
> and did **not** reproduce — see the verification note below. The rest stand
> as written.

## Verification note

**#13 (claimed nested bash permissions work) — does not reproduce on 1.18.4.**
Re-tested with a clean config pointed at via `OPENCODE_CONFIG` plus `--pure`:
`bash: { "git *": "allow", "*": "deny" }` still denies bash entirely. The
documentation is ahead of the pinned binary; the doc's statement stands.
Bonus finding from the re-test: `OPENCODE_CONFIG` did **not** isolate the
session from the global config (global MCP tools were still present),
which partially confirms #7's config-precedence concern.

---

## Theme A — Security / trust model

These are the load-bearing questions. The design currently hands the model
untrusted PR code plus a shell plus provider API keys in the environment.

- **A1 (#17)** — A pull request controls repository content: `opencode.json`,
  skills, `AGENTS.md`, `.claude/` instructions, and local MCP server
  definitions. When the review runs, that content is loaded with provider
  API keys in scope.
  **Question:** What is the trust model for PR-controlled config and content?
  Options: (a) accept as high-trust, `pull_request` event only, document the
  risk; (b) restrict config provenance to the base branch; (c) disable
  PR-controlled plugins/MCPs/instructions by default and require opt-in.

- **A2 (#15)** — `bash: allow` plus provider keys in env vars is a prompt
  injection exfiltration path: instructions hidden in PR code could make the
  model `curl` the keys out. "GitHub token scope is the safety boundary" is
  wrong — the token is not the only secret in the environment.
  **Question:** Do we (a) document this as an accepted risk of running an
  agent on untrusted code, (b) drop env-var keys for an isolated secret
  mechanism, or (c) add output/network constraints?

- **A3 (#14)** — Our `permission` block only gates bash. OpenCode defaults
  permit `edit` — the model can modify files in the checked-out repo.
  **Question:** Should the generated config default to `edit: deny` (and
  explicit allow/deny for every relevant tool), making reviews read-only
  by construction?

- **A4 (#16)** — `GITHUB_TOKEN` default permissions are repo/org-configurable,
  and comment posting requires `pull-requests: write` explicitly.
  **Question:** Do we require an explicit minimal `permissions:` block in
  every sample workflow and fail fast when the token can't post?

- **A5 (#24)** — Debug artifacts preserve raw model/tool streams, which can
  contain source code, credentials printed by tools, and provider responses.
  **Question:** What redaction, retention, and naming policy applies to
  debug artifacts? Is debug upload opt-in only?

## Theme B — `opencode.json` builder correctness

The builder's guarantee ("required settings always win") depends on details
that are currently unverified or undefined.

- **B1 (#7)** — Config precedence: if repo-root `opencode.json` loads after
  `OPENCODE_CONFIG`, the user's project config can override the action's
  required settings. The re-test suggests global config still loads even with
  `OPENCODE_CONFIG` set.
  **Question:** What is the actual load order for global / project /
  `OPENCODE_CONFIG` configs on the pinned version, and does the builder's
  guarantee survive it? If not, what isolation strategy replaces it?

- **B2 (#8)** — Writing the merged config to `$RUNNER_TEMP` changes the
  meaning of relative paths in the user's config (`{file:...}` references,
  plugin paths, MCP `cwd`).
  **Question:** Do we rebase relative paths to the original config
  directory, or write the merged config next to the source?

- **B3 (#9)** — "Merge" is undefined for nested objects, arrays (`plugin`),
  `null`, `$schema`, and provider collisions.
  **Question:** What is the deterministic deep-merge algorithm, with
  examples for each conflicting field type?

- **B4 (#18)** — Auto-generating provider entries from `provider/model` is
  not implementable for arbitrary custom providers (they need package,
  baseURL, model map, secret variable).
  **Question:** What is the supported built-in provider registry, and do
  custom providers have to be fully declared in trusted user config?

## Theme C — The "system prompt" isn't one

- **C1 (#11)** — The composed prompt is passed as the positional argument to
  `opencode run`, which makes it a user message. Repository instructions
  (`AGENTS.md`, `.claude/`) can compete with or override it.
  **Question:** Do we define an action-owned OpenCode **agent** (with the
  instructions in the agent definition, a privileged position) instead of
  prepending to the prompt? What does that config surface look like?

- **C2 (#12)** — `AI_REVIEW_SYSTEM_PROMPT` is described as inspectable
  "before invoking the action," but the action creates it during its own
  execution.
  **Question:** Fix the claim — expose the resolved prompt as a workflow
  artifact, an action output, or drop the inspection promise?

## Theme D — Interface and documentation holes

Mechanical, batch-fixable once A–C are settled.

- **D1 (#2)** — A push to the default branch has no PR to comment on. Where
  does a `full`-target review go — commit status, check run, issue, outputs
  only, or reject the event?
- **D2 (#3)** — Examples 9.1–9.3 and 9.5 omit checkout and OpenCode install;
  they don't run as shown. Make every example runnable end-to-end.
- **D3 (#4)** — `opencode-version` is an action input but the action doesn't
  install OpenCode. Pick one: action-owned install, or workflow-owned install
  plus a version assertion.
- **D4 (#5)** — Target resolution is undefined for `workflow_dispatch`,
  schedules, non-default-branch pushes, merge queues. Provide an
  event/target table and fail fast on unsupported combinations.
- **D5 (#6)** — The diff command requires `fetch-depth: 0` and an existing
  `origin/$BASE_REF`. Specify the checkout requirement and the exact
  base/head ref computation rather than letting the model guess.
- **D6 (#1)** — `comment-url` is listed under `run-reviews` outputs but
  posting happens in `post-comment`; the composite action's public interface
  (github-token, post-comment, max-comment-chars) needs one definition.
- **D7 (#20)** — Comma-separated `prompts` can't represent inline text
  containing commas. Use a JSON list or explicit `file:`/`text:` syntax.
- **D8 (#21)** — "Last model/prompt" depends on execution order; define
  deterministic result selection, null-cost policy, and aggregation fields.
- **D9 (#22)** — Fusion has no prompt contract: labeling, size limits,
  injection protection, tool access, cost accounting all unspecified.
- **D10 (#23)** — No failure-state matrix: timeouts, partial success,
  invalid config, fusion failure — exit codes, outputs, posting, cleanup.
- **D11 (#25)** — Supported runner platforms and required binaries unstated
  (curl|bash install, npx, Node 22+, git, Unix paths).
- **D12 (#26)** — Every "verified in 1.18.4" claim is the action's brittle
  ABI. Each needs a pinned contract test that fails clearly on incompatible
  CLI output.
- **D13 (#27)** — `@v1` action refs and `curl | bash --version` are not
  integrity pinning. Specify immutable release refs and checksum provenance.
- **D14 (#28)** — Section order buries prerequisites after internals; the
  doc lacks testing, release/versioning, and compatibility sections.

---

## Proposed order of attack

1. **Theme A** (design discussion — trust model for untrusted PR code)
2. **Themes B + C** (3–4 focused decisions: config precedence, merge
   algorithm, agent-vs-prompt, provider registry)
3. **Theme D** (batch doc fix once A–C are settled)
