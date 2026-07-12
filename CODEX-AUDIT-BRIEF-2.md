# ikbi — Second Full Audit Brief (for GPT-5.6 Sol / Codex, max reasoning)

This is the **second** deep audit. The first (your prior report) drove a full remediation program — see
`docs/CODEX-AUDIT-REMEDIATION.md` for exactly what was fixed and what was decided N/A. Your mandate now
has two halves, both adversarial and exhaustive:

1. **Verify the remediation.** For every fix that landed, confirm it actually closes the finding AND did
   not introduce a new bug (especially a false-GREEN, a fail-closed guard that is now open, or a
   concurrency regression). A wrong fix is worse than the original.
2. **Audit the whole codebase fresh**, with special scrutiny on the code that CHANGED since audit 1 —
   above all the newly-authoritative promotion path (§4). Determine, for each part, whether it is the
   best it can be, and where not, say precisely why and what to change.

Budget depth over speed — many hours of reasoning is expected. Read actual code, not names. Verify by
running the build and tests. Anchor every claim in `file:line`.

---

## 0. Threat model — READ THIS FIRST (it changes how you weight findings)

**ikbi is LAB-ONLY: a trusted, single-operator box** (README line 1: "⚠️ LAB-ONLY PRODUCT"; binds
localhost, meant to run behind Tailscale/VPN; "exists only for a trusted single-operator box";
SECURITY.md). There is **no untrusted principal** — the operator holds all tokens and controls all
inputs. Weight findings accordingly:

- **In scope (judge hard):** CORRECTNESS and ROBUSTNESS. The adjudication/promote-safety core; false-RED
  (green work discarded) and false-GREEN (bad work promoted); concurrency races that corrupt state in
  LEGITIMATE multi-process use (the CLI and the long-running service are two real processes); resource
  leaks; OOM on a corrupt/huge file; verifier truth under self-hosting; cost-efficiency of cheap-model
  builds.
- **Out of scope for THIS product (note but don't weight as CRITICAL):** privilege escalation between
  principals, tamper defense on the operator's own files, hostile-user prompt injection, credential
  epochs/revalidation, multi-tenant isolation. The prior audit's C9/C10/C13/H6/E4/E7-class adversarial
  findings were re-triaged as N/A-lab-only (see `docs/CODEX-AUDIT-REMEDIATION.md` + the memory note). If
  you find a NEW such issue, report it, but tag it "adversarial — lab-only N/A" so it is not conflated
  with a correctness bug. **Do not push production/multi-tenant hardening onto a lab tool.**

Injection/neutralization still matters, but for a NARROWER reason: the operator legitimately pulls in
untrusted CONTENT (web fetches, file reads, MCP results) that can carry instructions — so the
chokepoint's job is real, but the frame is "don't let fetched web content steer the build," not "defend
against a hostile user."

---

## 1. What ikbi is (then read `CLAUDE.md`, `docs/ARCHITECTURE-INVARIANTS.md`, `docs/PRODUCT-SPINE.md`)

ikbi ("to build", Choctaw) is a **governed AI coding agent** that makes **cheap/local models** produce
trustworthy work via evidence-based verification, governed execution, earned trust, deterministic
scaffolding. Long-running localhost/Tailscale service AND a CLI.

- TypeScript, Node 22+, ESM, pnpm. ~78K LOC source (407 files) + tests. `node:test` (NOT vitest).
  `pnpm build` = `tsc` (typechecks tests too). `pnpm test` (~3450 tests; confirm the baseline is green).
- **Frozen core** (`src/core/`): provider, injection (neutralization chokepoint), trust (MAC-protected),
  identity, workspace (git worktrees), events, receipt, substrate (atomic writes + locking), config,
  contracts, kill-switch. The security/correctness spine — change with extreme care.
- **Engine modules** (`src/modules/`): worker-model (the 5-role pipeline + the NEW adjudication core),
  chat, escalation, gate-wall, governed-exec, egress, verification-ladder, check-triage, self-heal/
  self-repair/recovery, mcp-model-loop, batch-planner, deterministic-judge, project-index, etc.
- Surfaces: CLI (`src/cli/`), Server (Fastify :18796), TUI (`tui/`), Web UI (`ui/`).

### The build pipeline (the heart — audit hardest)
`ikbi build "<goal>"` runs **scout → builder → verifier → critic → integrator** in an isolated git
worktree, **promoting only verified-green work**. The verifier runs real deterministic checks. The
promote decision is now made by the **Adjudication Core** (§4).

---

## 2. What changed since audit 1 (verify each — did the fix work, and is it correct?)

The full list with commit refs is `docs/CODEX-AUDIT-REMEDIATION.md` (workstreams A–E). Highlights to
re-verify adversarially:

- **The false-RED truth-half is claimed FIXED (H1):** `spec-artifact/store.ts` (+ `job-cards/store.ts`,
  `correction-library/store.ts`) defaulted their store dir to `homedir()/.ikbi/…`, ignoring
  `config.stateRoot`. Under bubblewrap the real home is read-only → the mid-build rescue verifier threw
  EROFS → certified green work RED. Now defaults under `stateRoot`. **Verify** the fix is complete (no
  other module hard-codes `homedir()` for state that the sandboxed verifier writes) and that this was
  genuinely the whole truth-half cause.
- **The Adjudication Core is now AUTHORITATIVE behind a flag (Cx) — §4.** Audit this hardest.
- **Verifier truth (C2):** verifier + builder now triage FULL stdout+stderr; exit-0-with-stderr-failures
  now fail. **Verify** no path still keys on the 2000-char tail or swallows a nonzero exit.
- **Deterministic judge (C3):** now disqualifies zero/absent/unverified test evidence (LAYER-1), aligned
  with the single-run integrator "executed"-required gate. **Verify** the competitive/tournament winner
  can never be a vacuous-green candidate.
- **Cross-process concurrency (D-workstream):** receipt seq-txn, kill-switch latch, lab-memory upserts/
  counters now use cross-process RMW (`DocumentStore.update` / a distinct `.seq.lock`). **Verify** the
  lock ordering is deadlock-free (esp. receipt `.seq.lock` nesting OUTSIDE the AppendLog's own `.lock`)
  and no new lost-update window exists.
- **Workspace (C1c/H3):** `promote()` accepts a hash-bound `verifiedAgainst`; discard/promote rehydrate
  git targets from the durable record. **Verify** correctness (and note: `verifiedAgainst` is NOT yet
  threaded from the orchestrator — see §4).
- **Substrate (M1):** `readJsonFile` now has a 16 MiB per-record cap. **Verify** it can't reject a
  legitimate record and that the oversize path fails closed correctly.

Do NOT re-report a finding the tracker marks fixed unless you can show the fix is **wrong or incomplete**
— in which case that is a high-value finding.

---

## 3. The non-negotiable invariants — PRESERVE, and FLAG any code that violates them

1. **Fail-closed is the default.** When in doubt, deny. An unwired gate-wall DENIES a promote.
2. **No false green (CARDINAL SIN).** Never promote without `verdict===pass` AND real *executed* test
   evidence bound to the promoted tree (not zero tests, not a stub `test` script, not `echo done`, not
   `|| true` exit-swallow, not a phantom empty-dir pass). Hunt every path that could promote unverified
   or vacuously-verified work — **especially the newly-authoritative adjudication path (§4).**
3. **No false red.** Correct, green work must never be discarded unseen (the historical recurring bug).
4. **Neutralization chokepoint is the only tool-result→model path.** Every tool result scanned + wrapped
   untrusted (a role:"tool" request message now must carry an explicit `untrusted` flag — the C9 guard).
   Verify no bypass; verify the guard doesn't wrongly reject legitimate ikbi-authored harness feedback.
5. **Judge by effect, not intent.** A PREVENTED (governor-blocked) attempt is a warning + learning
   signal, never a discard of verified-green work. Only an EFFECTIVE breach discards.
6. **Unverifiable ≠ red.** No derivable checks ⇒ `checks_unresolvable`, fails closed WITHOUT model-blame
   (no pro escalation, no trust demotion).
7. **Worktree confinement.** All file/search/exec confined to the worktree; `terminal` routes through
   governed-exec (allowlist + gate-wall + receipts + bubblewrap).
8. **Determinism & auditability.** Every promote/discard/retain decision is receipted with a closed-enum
   reason. The verifier is deterministic. Trust is MAC-protected.
9. **No shared deps / standalone.** Minimal runtime deps (fastify, @fastify/static, pino).
10. **Don't blame the model.** When ikbi fails where the same model succeeds elsewhere, suspect the
    HARNESS first.

---

## 4. DEEP FOCUS: the now-AUTHORITATIVE Adjudication Core (highest priority — false-GREEN risk)

Read `docs/ADJUDICATION-CORE.md`, `src/modules/worker-model/adjudication/` (contract.ts, core.ts,
work-product.ts + tests), and the orchestrator terminal.

**Thesis:** the builder is a WORKER, not a WITNESS — its exit status decides EFFORT, never work-goodness.
The verifier (real checks on the actual tree) is the sole witness; one pure/total
`decidePromotability(work, assessment, safety, critic)` is the judge, whose type signature CANNOT accept
a protocol exit (invariant I4). WorkProduct comes from git (not the tool ledger); WorkAssessment is
tree-hash-bound (no false green). Invariants I1–I9; I1/I2/I4/I5/I6/I7 have guard-test fixtures.

**What is now AUTHORITATIVE (audit this hardest — it is new, it changes what promotes, and its stated
key risk is MORE false-GREEN surface):** the single-build terminal (`orchestrator.ts`, ~line 3405) now
overrides the integrator's promote intent with `decidePromotability` when `IKBI_LEGACY_COMPLETION=off`
(default "on" = legacy, byte-identical). promote⇒promote, retain⇒keep-green-work (I1), discard⇒discard;
fail-closed if the tree facts can't be computed. The facts are built in the block ~line 3257 (shared with
shadow mode). Two tests cover it (fail-closed + a real-git promote-overriding-integrator).

**Audit questions — be adversarial:**
- Can the authoritative path promote work whose verifier verdict is stale relative to the promoted tree?
  Note: `assessment.treeHash` is set to `wp.treeHash` (the CURRENT worktree), i.e. it ASSUMES the
  verifier judged the current tree. Between the verifier role running and the terminal fact computation,
  could the tree change (a later escalation/rescue/commit)? Trace it. `verifiedAgainst` (C1c hash-bound
  promote) is NOT yet threaded here — so the WorkspaceManager does NOT re-check the landed tree against
  what the verifier saw. Is that a false-GREEN window? Design the fix (thread `verifiedAgainst` +
  target-head + a re-verify loop) and assess whether it should block the default flip.
- The `SafetyLedger` built at the terminal hardcodes `effectiveBreach:false` and `gateWallAuthorized:true`
  ("gate-wall enforced downstream"). Is "gate-wall enforced downstream" actually true on EVERY authoritative
  promote path? Is there any promote that skips the downstream gate-wall? Is `effectiveBreach` really never
  set anywhere it should be?
- `testEvidence` derivation (`readVerifier`, `checks.ts parseTestCount`): can a self-hosting run yield
  "executed" when tests did NOT genuinely pass? Can a scoped/ladder check set report executed evidence
  that doesn't cover the change? This is the false-GREEN backstop — probe it.
- Only the SINGLE-build terminal is wired. The **competitive** (orchestrator ~3946), **tournament**
  (~4128), **batch-planner**, **chat /apply**, and **self-heal** promote paths still use the OLD gate
  (Cx funnel + C7 batch-integration-workspace are unbuilt). Do those paths have the same false-RED /
  false-GREEN exposure the core was built to fix? Which is the highest-risk un-funnelled path?
- Is the design's remaining plan (funnel all paths, EffortPolicy absorbing the rescue mutators, flip the
  default + delete legacy, the C7 batch integration workspace) correct and sufficient? Where could it
  introduce a false-GREEN? Is there a simpler correct design? **Is it safe to flip the default?** What
  must be true first?

The orchestrator (`orchestrator.ts`, ~4300 lines) is still a **patch graveyard** — the promote/discard
decision remains scattered across ~16 branches + integrator sub-gates + rescue mutators, now with the
authoritative override layered on top. Assess the scattering ruthlessly: the centralization is
half-done (authoritative decision computed centrally, but the old branches still run around it).

---

## 5. Complexity hotspots — scrutinize hardest

- `src/modules/worker-model/orchestrator.ts` (~4,300) — the run loop, escalation, promote/discard
  terminals, rescue mutators, AND the new authoritative-adjudication override. Patch graveyard.
- `src/modules/worker-model/adjudication/` — the new core (§4).
- `src/modules/worker-model/verifier.ts` + `checks.ts` + `check-triage/` — the verification-truth layer.
  `parseTestCount` is an order-dependent regex zoo; builder in-loop `run_checks` vs the verifier's full
  stream; self-hosting test-output pollution; flaky-test tolerance.
- `src/modules/worker-model/builder.ts` (~2,200) — builder tool loop + chokepoint usage + `run_checks`.
- `src/modules/chat/session.ts` (~2,600) — REPL/session loop.
- `src/core/workspace/manager.ts` (~950) — worktree lifecycle, promote CAS + the new `verifiedAgainst`
  + rehydrate-from-record; autoCommit tied to trust tier (a correctness signal entangled with a trust
  decision — still true? investigate).
- `src/core/injection/`, `src/core/trust/`, `src/modules/gate-wall/`, `governed-exec/`, `egress/`.
- `src/modules/deterministic-judge/`, `src/modules/batch-planner/` (the un-funnelled promote paths).

---

## 6. Review dimensions — apply ALL to every section

Correctness · Promote-safety (false-green AND false-red — highest priority) · Robustness (flaky/timeout/
ENOBUFS/truncation in the verifier; git desync; self-hosting hazards; provider errors; kill/budget
mid-run) · Concurrency/lifecycle (worktree alloc/promote/discard/retain; cross-process locking; the
un-funnelled parallel paths) · Dead code/reachability (`@status` dormant code; the shadow-vs-authoritative
duplication) · Simplicity/coherence (collapse scattered special-cases WITHOUT losing a guarantee — the
centralization is half-done) · Test quality (real contracts vs trivia; false-green stubs; self-hosting
test-output pollution; coverage of the authoritative path) · Performance/cost (wasted verifier
dispatches, redundant full-suite runs).

---

## 7. How to work + severity

- Read real code; run it (`pnpm build && pnpm test`, ~3450 tests, confirm green). Write a focused failing
  test to confirm a suspected bug before claiming it.
- Never propose weakening a fail-closed guard to fix a false-RED — separate concerns, don't trade one
  failure mode for a worse one.
- **Severity (lab-only weighting):**
  - **CRITICAL** — a false-GREEN vector (promotes bad/unverified work), or data loss / state corruption.
  - **HIGH** — a false-RED / correctness bug that loses good work or produces wrong outcomes; a
    fail-closed guard that is actually open; a concurrency race that corrupts durable state in normal
    multi-process use; a remediation fix that is wrong/incomplete.
  - **MEDIUM** — robustness gaps (flaky/timeout/desync), scattered logic that is a latent bug factory,
    missing coverage on the promote path, wasted cost.
  - **LOW** — simplification, naming, dead code, docs.
  - **ADVERSARIAL–N/A** — a real hardening gap that only matters vs a hostile principal (out of scope
    for this lab tool; tag it, don't rank it CRITICAL).
- Every finding: `file:line`, what's wrong, why it matters (which invariant), a concrete fix (diff
  sketch), how you verified. Don't pad — if a section is solid, say so and move on.

---

## 8. Output format

1. **Executive summary** — the 5–10 most important findings, ranked, one line each.
2. **Remediation verification** — for each major prior-audit fix, a one-line verdict: correct / incomplete
   / regressed (with file:line for any that are wrong).
3. **CRITICAL / HIGH / MEDIUM / LOW / ADVERSARIAL–N/A findings** — grouped, each with title, file:line,
   description, why it matters, fix, confidence.
4. **The authoritative Adjudication Core (§4)** — is the promote-safety decision now defensible? Is it
   safe to flip `IKBI_LEGACY_COMPLETION` to default? What must be true first (esp. re false-GREEN)? Which
   un-funnelled path is highest-risk? This is the priority deliverable.
5. **Architecture assessment** — the single highest-leverage refactor; are the invariants (§3) upheld
   everywhere; is the half-done centralization coherent.
6. **What would make ikbi the best it can be** — the prioritized, must-fix-first roadmap.

Assume a skeptical expert reader who will check your file:line references. The goal is a rigorous
determination of whether each part is the best it can be, and a precise, verified path to making it so.
