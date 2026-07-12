# Handoff — Authoritative Adjudication-Default Flip

**Branch:** `adjudication-authority-flip` (from `harness/cc-parity-and-bokahli-pilot` @ `99db3da`).
**Status:** ✅ COMPLETE — the authoritative adjudication core is the DEFAULT promotion decision. Full
suite green in all three modes; live canaries pass. Nothing merged/tagged/published; no PR opened.

## The invariant this establishes

> Every promotion decision is made once, by the authoritative adjudication core, from a tree-bound green
> work product whose "verifiedAgainst" identity matches the candidate being considered.

- **Made once** — `decidePromotability` is the single promote/retain/discard authority (I9). In authoritative
  mode it REPLACES the integrator's promote intent at the terminal gate; the downstream `promoteCandidate`
  enacts + gates (gate-wall, stale-tree/CAS, physical snapshot) but does not re-decide. When the core
  withholds an integrator-approved build, the same canonical audit receipt is emitted referencing the core's
  decision (see WS3 below) — no second reducer overrides it.
- **Tree-bound green work product** — the core requires `verdict=pass ∧ evidence acceptable ∧
  assessment.treeHash === work.treeHash`. Evidence is `executed`, or `absent` under an EXPLICIT no-tests
  policy; `zero`/`unverified`/missing always block (I6, no vacuous green).
- **verifiedAgainst identity matches** — enforced in two places: the core's `treeHash` match (the verifier
  judged this worktree), and `promoteCandidate`'s stale-tree/CAS binding at land (the promoted content ==
  the verified tree). A PROVEN non-git workspace has no tree identity and takes the legacy logical binding;
  an INDETERMINATE identity (a git error) fails closed.

## What changed

### Production (`src/`) — all behind the existing flag until WS4; WS4 flips the default
- **`OrchestratorDeps.computeWorkProduct`** (`orchestrator.ts`) — a sanctioned, test-only fact-injection
  seam for the tree-bound `WorkProduct`. Production default computes from real git
  (`computeWorktreeWorkProduct`). NO env var injects facts; NO permissive fallback from missing facts; the
  seam cannot override CAS/landed-tree verification. Wired at the adjudication + auto-verify-rescue sites.
- **No-tests policy in the core** (`adjudication/core.ts`, `contract.ts`, `orchestrator.ts`) —
  `WorkAssessment.noTestsAcceptable` (from `task.noTestsPolicy` / `IKBI_ALLOW_NO_TESTS`) lets a genuinely
  test-less repo promote on `absent` evidence, the SAME rule `evaluateExecutedTestEvidence` enforces.
  Receipts still record the raw evidence state. `zero`/`unverified` still block.
- **Non-git logical binding** (`orchestrator.ts`) — a PROVEN non-git workspace (resolved via
  `resolveWorkspaceIdentity`, not a git/process error) is exempt from the tree-identity gate and promotes
  on the logical binding, preserving the legacy authority. The identity probe runs ONLY when the real git
  computation throws, so git-backed candidates (and the stale-tree `treeSeq` sequencing) are untouched.
  INDETERMINATE identity still fails closed (IKBI-REAUDIT2-002 — no laundering a git error into an exemption).
- **Canonical withholding receipts (I9)** (`orchestrator.ts`) — when the authoritative core WITHHOLDS an
  integrator-approved build, it emits the same canonical audit event the downstream authority would:
  `worker.promotion.evidence_withheld` (vacuous green) / `worker.promotion.semantic_withheld` (non-pass
  semantic verdict), referencing the core's decision. Mutually exclusive with `promoteCandidate`'s emission
  (which fires when the core promotes). Best-effort; never breaks the build.
- **Truthful retain reasons** — an external-injection safety-forensics retain names the injection; a
  failed-build retain reports the failure outcome (not the adjudication sub-verdict); a confirm-promote
  preserves the integrator's rationale and annotates it.
- **WS4 default flip** (`orchestrator.ts`) — authoritative is the DEFAULT. Legacy completion is a
  DEPRECATED explicit opt-in selected ONLY by `IKBI_LEGACY_COMPLETION=on`; missing / `off` / any invalid
  value ⇒ authoritative (fail-closed; an invalid flag can never re-enable the old gate). A per-build
  deprecation warning fires on opt-in. **UNCHANGED:** the autonomous-promotion QUARANTINE
  (`IKBI_ENABLE_AUTONOMOUS_PROMOTION`, default off) and gate-wall bypass still independently gate whether a
  verdict may LAND. The flip decides the VERDICT only.

### Tests — corpus migration (WS1)
~26 promotion-authority test files were migrated to production-representative facts via the seam, NOT
rewritten one-by-one. Each test's INTENT was preserved: a promote-expecting test injects a complete
tree-bound GREEN work product + a green critic (`detail.pass`) + executed-evidence verifier double; a
refusal test injects the intended missing/empty/mismatched fact (or refuses upstream at gate/verifier/
drift/quarantine/stale-tree/injection). No `promoted:true`→`false` flip; no assertion deleted. Real-git
integration coverage remains (promotion-authority, phase13c, safety-evidence, semantic-contract all use
real temp git repos where the tree identity matters).

## Validation matrix

| Mode | Command | Result |
|---|---|---|
| **Default** (authoritative) | `pnpm test` | **3915 pass / 0 fail** |
| Explicit authoritative | `IKBI_LEGACY_COMPLETION=off … --test src/**` | **3915 / 0** |
| Legacy opt-in (deprecated) | `IKBI_LEGACY_COMPLETION=on … --test src/**` | **3915 / 0** |
| Build (strict tsc) | `pnpm build` | clean |

(`# tests 3916` = 3915 + 1 skip/todo.)

### Live canaries (disposable /tmp clone, `IKBI_GATE_WALL_BYPASS=false`, DeepSeek roster)
- **Canary A** — autonomous promotion OFF. Real brownfield task (fix a buggy `add` + failing test). The
  build produced a GREEN product (all roles green, +16/−1), the authoritative core recommended promote, and
  the QUARANTINE backstop blocked the autonomous land → **REJECTED, repo HEAD unchanged (no land), work
  retained** in workspace `29c94b3260aceab4` for review, **no governed trust**. Task `build-1783889157784`.
- **Canary B** — autonomous promotion ON, bypass false. Same task → authoritative core promoted → single
  decision point → **LANDED** (repo HEAD advanced), the landed `src.js` is the correct fix
  (`(a,b) => a + b`), and the test **passes on the landed tree (1/0)**. Task `build-1783889241416`.

Both confirm: the core is the single promote authority; the quarantine + gate-wall are independent land
gates that the flip did not weaken.

## Commits (unpushed → now pushed to origin/adjudication-authority-flip)
```
630e9db  tree-bound fact seam + no-tests policy in the authoritative core   (WS1 + WS2 slice)
513fb78  migrate fixer-rescue, subagent-spawning, batch-planner fixtures    (WS1)
7919b45  authoritative core green across the whole suite (non-git + WS3 receipts)  (WS2 + WS3)
b4c7245  make authoritative completion the DEFAULT (WS4 flip)               (WS4)
```
All pushed. Original branch `harness/cc-parity-and-bokahli-pilot` (@ `99db3da`) untouched.

## Remaining / follow-ups
- **Remove the legacy opt-in entirely** after a deprecation window (delete the `IKBI_LEGACY_COMPLETION=on`
  branch + the integrator-decides terminal). The full suite already passes in authoritative mode, so the
  removal is mechanical; keep the I1–I9 guard fixtures.
- **Non-git nonEmpty is a logical `true`.** A proven non-git workspace promotes on the logical binding
  without a work-on-disk check (the legacy behavior). ikbi builds are git-worktree-based in practice, so
  this is an edge/test path; if a real non-git build surface appears, derive `nonEmpty` from the builder
  ledger instead of assuming `true`.
- **Canonical withholding receipt mapping** currently covers vacuous-green → evidence_withheld and
  critic-fail(non-pass semantic) → semantic_withheld. If other core-withhold reasons need a specific
  downstream-parity receipt, extend the map in the CX block (`orchestrator.ts`, "CANONICAL WITHHOLDING
  RECEIPT" comment).
- **Shadow telemetry** (`IKBI_ADJUDICATION_SHADOW`, default on) still emits divergence receipts in
  authoritative mode (old integrator intent vs core) — useful signal; safe to leave on or retire later.
