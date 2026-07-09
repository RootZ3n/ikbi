# ikbi — Full End-to-End Audit Brief (for GPT-5.6 Sol / Codex, max reasoning)

You are performing a **complete, line-by-line audit of the entire ikbi codebase** — not just recent
work, every section. Your mandate: **determine, for each part, whether it is the best it can be**, and
where it is not, say precisely why and what to change. Be exhaustive, adversarial, and concrete. This is
a security-sensitive, safety-critical system; hold it to that bar.

Budget your effort for depth over speed. It is acceptable and expected that this takes many hours of
reasoning. Read actual code, not just names. Verify claims by running the build and tests.

---

## 0. What ikbi is (read this first, then `CLAUDE.md`, `docs/ARCHITECTURE-INVARIANTS.md`, `docs/PRODUCT-SPINE.md`)

ikbi ("to build", Choctaw) is a **governed AI coding agent** designed to be a Claude Code replacement
that works with **cheap/local models**. The thesis: give cheap models every structural advantage —
evidence-based verification, governed execution, earned trust, deterministic scaffolding — so a weak
model produces trustworthy work. It runs as a long-running localhost/Tailscale service AND as a CLI.

- **TypeScript, Node 22+, ESM, pnpm workspace.** ~78K LOC source (407 files) + ~58K LOC tests (307
  files). `node:test` runner (NOT vitest). `pnpm build` = `tsc` (typechecks tests too). `pnpm test`.
- **Frozen core** (`src/core/`): provider (model invocation), injection (the neutralization
  chokepoint), trust (earned tiers, MAC-protected), identity, workspace (git worktrees), events,
  receipt, substrate (atomic writes + locking), config, contracts, kill-switch, gbrain-bridge.
  **Change with extreme care** — it is the security spine.
- **Engine modules** (`src/modules/`, ~60): worker-model (the 5-role build pipeline), chat, escalation,
  gate-wall, governed-exec, egress, verification-ladder, check-triage, integrator logic, escalation,
  self-heal/self-repair/recovery, mcp-model-loop, project-index/retrieval, adjudication (NEW), etc.
- **Surfaces**: CLI (`src/cli/`, `node dist/cli/index.js <cmd>`), Server (Fastify :18796), TUI
  (`tui/`), Web UI (`ui/`, static SPA — see `docs/UI-OPERATIONS.md`).

### The build pipeline (the heart, audit it hardest)
`ikbi build "<goal>"` runs a 5-role pipeline — **scout → builder → verifier → critic → integrator** —
in an **isolated git worktree**, and **promotes only verified-green work**. The verifier runs real
checks (typecheck + tests) deterministically. The integrator is the promote gate. Everything routes
through governance (gate-wall), neutralization (injection chokepoint), and receipts (audit trail).

---

## 1. The non-negotiable invariants — PRESERVE these, and FLAG any code that violates them

These are the design's load-bearing properties. A "best it can be" recommendation must never weaken
them; part of your job is to **find places where the code silently violates them**.

1. **Fail-closed is the default.** Never make a dangerous thing the default. Trust/capability/authorization
   is *granted*, not assumed. When in doubt, deny. (e.g. an unwired gate-wall must DENY a promote, not
   advisory-allow it.)
2. **No false green.** A build must NEVER promote without a genuine, real verification: `verdict === pass`
   AND real *test evidence* (tests actually ran — not zero tests, not a stub `test` script, not
   `echo done`, not `|| true` exit-swallowing, not a `node --test <emptydir>` phantom pass). Hunt for
   any path that could promote unverified or vacuously-verified work. This is the cardinal sin.
3. **No false red (the current focus).** Correct, green work must NEVER be discarded unseen. The system
   has historically done this repeatedly ("false RED"): a builder produces green code but the pipeline
   marks the build failed and throws it away. See §4.
4. **The neutralization chokepoint is the only path from a tool result to the model.** Every tool result
   is scanned + wrapped as untrusted. Injection detected from OUTSIDE content blocks promotion; injection
   in the build's own worktree output is judged by effect (neutralized-and-inert). Verify the chokepoint
   has no bypass.
5. **Judge by effect, not intent.** A PREVENTED (governor-blocked) out-of-policy attempt had no effect —
   it must not discard verified-green work; it is a warning + learning signal. Only an EFFECTIVE breach
   (a control that actually failed — sandbox escape, egress leak, out-of-workspace write, receipt
   tampering) discards. Check this is applied consistently.
6. **Unverifiable ≠ red.** A target with no derivable checks (no manifest/test runner) is
   `checks_unresolvable` — it fails closed WITHOUT model-blame: no pro escalation, no trust demotion.
   A stronger model can't fix a missing verifier.
7. **Worktree confinement.** All file/search/exec tools are confined to the worktree. `terminal` routes
   through governed-exec (allowlist + gate-wall + receipts + OS sandbox/bubblewrap). Verify no escape.
8. **Determinism & auditability.** Every promote/discard/trust decision must have a clear, receipted
   reason. The verifier is deterministic (no model). Trust is MAC-protected.
9. **No shared dependencies / no shared core package.** ikbi is standalone. Runtime deps are minimal
   (fastify, @fastify/static, pino). Don't recommend adding heavy deps.
10. **Don't blame the model.** When ikbi fails where the same model succeeds elsewhere, suspect the
    HARNESS first. Many "model failures" are harness-mechanics bugs. This is the debugging philosophy.

---

## 2. Review dimensions — apply ALL of these to every file/section you read

For each area, evaluate against every relevant dimension:

- **Correctness** — logic bugs, off-by-one, wrong conditionals, race conditions, unhandled async
  rejections, incorrect error propagation, state that can desync.
- **Security / fail-closed** — can any path promote unverified work (false green)? bypass the injection
  chokepoint? escape the worktree/sandbox? leak via egress? forge identity/trust? tamper receipts?
  advisory-allow where it must deny? Trust MAC integrity? Injection detector coverage + evasion.
- **Promote-safety (highest priority)** — trace *every* path from a role result to promote/discard/retain.
  Is the promote gate provably fail-closed? Is the false-RED (green work discarded) fully closed? Is the
  decision centralized or scattered (it is currently scattered — see §4)?
- **Robustness** — flaky/timeout/ENOBUFS/truncation handling in the verifier; git desync; partial writes;
  what happens on provider errors, context overflow, kill/budget mid-run; self-hosting (ikbi building
  ikbi) hazards.
- **Concurrency / lifecycle** — worktree allocation/promote/discard/retain; locking (substrate); the
  competitive/tournament parallel paths; serial-build assumptions.
- **Dead code / reachability** — orphaned modules, unreachable branches, `@status`-labeled dormant code
  that should be wired or deleted, duplicated logic (e.g. mirrored commit gates).
- **Simplicity / coherence** — the biggest files are patch-graveyards (see §3). Where can scattered
  special-cases collapse into one well-named abstraction WITHOUT losing a guarantee? Naming, layering,
  contract cleanliness. Prefer removing a branch over adding one.
- **Test quality** — are tests pinning real contracts or implementation trivia? false-green in tests
  (stub verifiers that don't model reality)? missing adversarial cases? Do the tests actually run what
  they claim (self-hosting test-output pollution is real here)?
- **Performance / cost** — cheap-model builds are cost-sensitive; wasted verifier dispatches, redundant
  full-suite runs, unbounded loops, context bloat.

---

## 3. Complexity hotspots — scrutinize these hardest (largest / most-patched)

- `src/modules/worker-model/orchestrator.ts` (**4,305 lines** — the 5-role run loop, escalation,
  promote/discard terminals, rescue mutators). This is a **patch graveyard**: dozens of `FIX`/`Bug`/`H*`/
  `D*`/`CODEX FIX` markers layered on the same decision logic. The promote/discard decision is spread
  across **~16 branches + 7 integrator sub-gates + 7 rescue mutators + a duplicated competitive path**.
  This scattering is the root of recurring breakage. Assess ruthlessly.
- `src/modules/chat/session.ts` (2,636) — the interactive REPL/session loop.
- `src/modules/worker-model/builder.ts` (2,183) — the builder tool loop + the neutralization chokepoint
  usage + `run_checks`.
- `src/modules/worker-model/verifier.ts` (1,257) + `checks.ts` (803) + `check-triage/` — the
  verification-truth layer. Known-fragile: `parseTestCount` is an order-dependent regex zoo; the
  builder's in-loop `run_checks` triages only the last ~2000 chars (vs. the verifier's full stream);
  builder checks are never scoped (runs the full ~3400-test suite every check); zero flaky-test
  tolerance (any failing test anywhere → whole build RED).
- `src/core/workspace/manager.ts` (913) — worktree lifecycle, promote/commit gate (autoCommit tied to
  trust tier — a correctness signal entangled with a trust decision; investigate).
- `src/core/injection/` — the neutralization chokepoint. `src/core/trust/` — MAC-protected tiers.
  `src/modules/gate-wall/`, `governed-exec/`, `egress/` — the governance/sandbox/SSRF floor.

---

## 4. Deep focus: the Adjudication Core (fresh, safety-critical, has a live bug)

Read `docs/ADJUDICATION-CORE.md` in full. Context: ikbi has a **recurring false-RED** — a builder
produces correct, fully-green code, but the pipeline discards it (marks the build a failure). Root cause
diagnosed: the pipeline **conflates "did the builder follow protocol?" with "is the work good?"** and
scatters the answer. The fix in flight (commits `78d36f9`, `6eb76b8`, `20a8481`, `9354f46`, `e693ce8`):

- **Thesis:** the builder is a WORKER, not a WITNESS. Its exit status decides whether to keep spending
  EFFORT — never whether the work on disk is good. The verifier (real checks on the actual tree) is the
  sole witness; one `decidePromotability(work, assessment, safety, critic)` is the judge, and its type
  signature CANNOT accept a protocol exit (invariant I4).
- **Built so far:** `src/modules/worker-model/adjudication/` — the pure core (`decidePromotability`,
  `computeWorkProduct` from git, the four fact-types, 25 tests); shadow mode in the orchestrator
  (telemetry, validated live — it caught the false-RED in a receipt); and terminal adjudication (run the
  verifier once on the FINAL builder result, rescue on green).
- **KNOWN OPEN BUG — root cause LOCALIZED (help fix):** the decision-half (terminal adjudication) is
  WORKING. A diagnostic build (`e693ce8`) proved it: `workNonEmpty: true, rescueAttempted: true,
  rescueResult: "fail"` — i.e. the adjudicator correctly detects the work on disk and runs the verifier.
  The remaining false-RED is that **the rescue VERIFIER returns RED on provably-GREEN work.** Verified by
  hand: the build's final worktree typechecks clean, the module's own tests pass, AND its full
  `pnpm test` suite passes 3402/3402 when run in isolation — yet the verifier, run mid-build on that same
  tree, went red. So the bug is now in the **verification-truth layer, not the model, not the
  adjudication decision.** This is the "truth-half" the audit predicted (see below). REFUTED hypotheses
  (do not re-chase): it is NOT a flaky suite (2+ consecutive green isolated runs), and NOT nested-TAP
  mis-parsing (a passing self-hosting run emits 0 `not ok` / nonzero `# fail` lines). REMAINING candidate
  mechanisms to trace in the verifier's mid-build check run: (a) a per-check timeout too short for the
  ~40s+ self-hosting suite under concurrent build load → SIGKILL → false red (compare
  `DEFAULT_CHECK_TIMEOUT_MS` / `resolveCheckTimeoutMs` vs. governed-exec's own timeout on the path the
  RESCUE verifier uses); (b) governed-exec/bubblewrap sandbox restricting a test that needs
  fs/net/ports when run inside the build (isolated runs are unsandboxed); (c) ENOBUFS / output-tail
  truncation on the huge suite output feeding the triage parser; (d) the rescue verifier resolving a
  DIFFERENT (scoped/ladder) check set than the isolated `pnpm test`. **Trace the exact check the rescue
  verifier ran and why it returned fail** — inspect the receipts (`~/.ikbi/state/receipts/`) for this
  build's verifier check `exitCode` + `outputTail`, and the governed-exec timeout on the rescue path.
  Then design the truth-half fix (below) so the verifier cannot false-RED green work when self-hosting.
- **Also flag:** the diagnostic log in `e693ce8` is temporary and should be removed or converted to
  durable telemetry once the truth-half is fixed.
- **The design's remaining work (evaluate the design too, not just the code):** Step 3-full centralizes
  the ~16 scattered branches + 7 integrator sub-gates into `decidePromotability` as the single
  authoritative gate, with an EffortPolicy absorbing the rescue mutators; plus the truth-half fixes
  (scope the builder's checks to the module + give it full stdout + a bounded flaky re-run), keeping
  `testEvidence` as the false-GREEN backstop. Is this design correct and sufficient? What does it miss?
  Where could it introduce a false-GREEN? Is there a simpler correct design?

There is a temporary diagnostic commit (`e693ce8`) that should be removed once the bug is fixed — flag it.

---

## 5. Systematic traversal plan (so you cover everything)

Work section by section; for each, produce findings. Suggested order (highest-risk first):

1. **Frozen core** (`src/core/`): injection, trust, identity, provider, workspace, substrate, receipt,
   kill-switch, config, contracts, events, gbrain-bridge. Prove the security spine.
2. **The build pipeline** (`src/modules/worker-model/`): orchestrator, builder, verifier, checks,
   check-triage, verification-ladder, integrator logic, escalation, adjudication, patchsmith,
   multi-audit, fix mode, competitive/tournament.
3. **Governance & execution**: gate-wall, governed-exec, egress, execution-policy, dependency-install,
   mcp-model-loop.
4. **Cognition & recovery**: chat, agent-router, batch-planner, step-planner, cognition-layer, consult,
   model-router, escalation, self-heal, self-repair, recovery, self-monitor, self-observation,
   drift-prevention, correction-library.
5. **Knowledge & context**: project-index, project-retrieval, context-packets, lab-context-memory,
   labmem-recall, reachability-guard, capability-*, memory-governor.
6. **Surfaces**: `src/cli/`, `src/server/`, `tui/`, `ui/`.
7. **Tests**: sample broadly — are they pinning real contracts? any false-green stubs? coverage gaps on
   the promote path?

---

## 6. How to work

- **Read the real code**, top to bottom, in the hotspots and the security spine. Do not rely on names,
  comments, or this brief — verify.
- **Run it.** `pnpm install && pnpm build && pnpm test` (2600+ tests). Confirm the baseline is green.
  When you suspect a bug, write a focused failing test or a minimal repro to confirm it before claiming.
- **Respect the invariants (§1).** Never propose weakening a fail-closed guard to fix a false-RED — the
  correct fix separates concerns, it does not trade one failure mode for a worse one.
- **Distinguish severity precisely:**
  - **CRITICAL** — a false-green vector, a security bypass (injection/sandbox/egress/trust/identity), or
    data loss.
  - **HIGH** — a false-RED / correctness bug that loses good work or produces wrong outcomes; a
    fail-closed guard that is actually open.
  - **MEDIUM** — robustness gaps (flaky/timeout/desync), scattered logic that is a latent bug factory,
    missing test coverage on a risk path.
  - **LOW** — simplification, naming, dead code, cosmetic, docs.
- **Be adversarial.** For each guarantee, actively try to construct an input/sequence that breaks it.
- **Every finding:** file:line, what's wrong, why it matters (which invariant/behavior), a concrete fix
  (ideally a diff sketch), and how you verified it.
- **Don't hand-wave or pad.** If a section is genuinely solid, say so briefly and move on. Prioritize.

---

## 7. Output format

Produce a single structured report:

1. **Executive summary** — the 5–10 most important findings, ranked, each one line.
2. **CRITICAL / HIGH / MEDIUM / LOW findings** — grouped by severity, each with: title, file:line,
   description, why it matters, recommended fix, verification/confidence.
3. **The Adjudication Core** — the root-cause of the open false-RED bug (§4), whether the design is
   correct/sufficient, and the exact fix. This is the priority deliverable.
4. **Architecture assessment** — is the promote-safety decision defensible as-is? What is the single
   highest-leverage refactor? Are the invariants (§1) actually upheld everywhere?
5. **Section-by-section notes** — brief per-area verdict ("solid" / "needs work + why") covering §5.
6. **What would make ikbi the best it can be** — the prioritized roadmap, must-fix first.

Anchor every claim in code. Assume a skeptical, expert reader who will check your file:line references.
The goal is not a list of nitpicks — it is a rigorous determination of whether each part is the best it
can be, and a precise, verified path to making it so.
