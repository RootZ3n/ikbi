# HANDOFF — Phase 10: One Evidence-Bearing Promotion Authority (IKBI-REAUDIT-001 / -006)

**Branch:** `harness/cc-parity-and-bokahli-pilot` · **Status:** complete, committed, NOT pushed
**Result:** `pnpm build` clean · `pnpm test` = **3628 tests, 3627 pass, 1 skip, 0 fail** (Phase 9 baseline 3613 → +15)

## The central invariant

> No autonomous authoritative change without authentic, candidate-bound, EXECUTED verification evidence
> and an ENFORCEABLE tree identity.

## 1. Root cause of the findings

- **IKBI-REAUDIT-001 (critical):** the multi-step FINAL pass sets `reuseWorkspace`, and the integrator
  computed `accumulatedPass = task.reuseWorkspace !== undefined` then `testEvidenceOk = accumulatedPass ||
  testEvidence === "executed"`. So an accumulated final could promote on `zero`/`unverified`/`absent`/
  missing test evidence — "reuse workspace" was used as a proxy for "prior steps verified," but intermediate
  steps set `skipVerifier: true`. `promoteCandidate()` recorded `verificationPassed` but never ENFORCED it
  or executed-test evidence, so nothing downstream caught it. (`integrator.test.ts` even asserted the hole.)
- **IKBI-REAUDIT-006 (medium):** `readTreeHash()` caught ALL errors → `undefined`, indistinguishable from
  "not a git worktree," so a transient hash-read failure on a real workspace silently dropped the stale-tree
  check AND `verifiedAgainst`. REPL `/apply` called `mgr.promote()` directly with no `verifiedAgainst`, no
  executed-test/semantic gate, and no "manual/unverified" receipt — a promotion bypass outside worker authority.

## 2. Pre-change authority inventory (reconciled from 3 read-only subagents)

| Path | Entry | workspaces.promote | verificationPassed enforced? | executed-test enforced? | tree-id fail-closed? | receipt | class |
|---|---|---|---|---|---|---|---|
| Normal worker | orchestrator normal terminal → `promoteCandidate` (4405) | via authority | **no (recorded only)** | **no** | **no (fail-open on undefined)** | `worker.promotion` | autonomous |
| Primary/peer duel | same, lane-suffixed | via authority | no | no | no | `worker.promotion` | autonomous |
| Fixer/rescue | re-verify → normal terminal | via authority | no | no | no | `worker.promotion` + `worker.fixer` | autonomous |
| Multi-step final | `cli.ts` final task (reuseWorkspace) → integrator → authority | via authority | no | **BYPASSED by accumulatedPass** | no | `worker.promotion` | autonomous |
| Tournament | `promoteCandidate` (5189) | via authority | no | no | no | `worker.promotion` | autonomous (git-apply denied) |
| Competitive | `promoteCandidate` (4976) | via authority | no | no | no | `worker.promotion` | autonomous |
| Legacy / `=off` | terminal (default / quarantined) | via authority | no | no | no | `worker.promotion` | autonomous |
| **REPL `/apply`** | `repl-workspace.ts:151` → `mgr.promote()` DIRECT | **bypasses authority** | no | no | no `verifiedAgainst` | none labelled | **impersonated autonomous** |

Only `promoteCandidate` calls `workspaces.promote` in the worker (the Phase 3 single-authority source test
still holds); the REPL was the one out-of-worker bypass.

## 3. Authority-mode taxonomy (now enforced)

- **Autonomous verified promotion** — `promoteCandidate()`. Requires policy + gate-wall + semantic pass +
  `verificationPassed` + executed-test evidence + enforceable tree identity. Emits `worker.promotion`;
  success trust only after it lands.
- **Manual unverified apply** — REPL `/apply`. A trusted operator explicitly applies; gate-wall still gates
  and the tree is hash-bound, but it is labelled `manual-unverified`, certifies NO tests/semantics, emits
  `workspace.manual_apply` (never `worker.promotion`), and awards NO success trust.
- **Candidate selection** (tournament/competitive/integrator) — chooses WHAT to evaluate; not promotion.
- **Verification result / recommendation** (verifier / critic / adjudication) — evidence/opinion; not authority.

## 4. Executed-test-evidence contract (`executed-evidence.ts`)

`evaluateExecutedTestEvidence(evidence, {allowNoTests})` maps the verifier's four-state `TestEvidence`
(`executed`|`zero`|`unverified`|`absent`) + missing/undefined into one fail-closed decision, without
collapsing the states: `executed` → acceptable; `absent` → acceptable ONLY under an explicit named policy
(`task.noTestsPolicy` or `IKBI_ALLOW_NO_TESTS=true`, resolved by `noTestsPolicyEnabled`); `zero`/`unverified`/
missing → BLOCK. A model claim, a suggested command, or a prior candidate's tests never reach this as
`executed` — the verifier derives `executed` only from an OBSERVED test check with a parsed count.

## 5. Multi-step: before → after

- **Before:** intermediate steps `skipVerifier`; the final `reuseWorkspace` task ran the full verifier but
  the integrator's `accumulatedPass` waived the test-evidence gate → could promote on non-executed evidence.
- **After:** the `accumulatedPass` **test-evidence** exemption is REMOVED. `accumulatedPass` still relaxes
  the `filesWritten>0` builder gate (a final verify pass legitimately writes nothing, `writeScope:none`), but
  the final accumulated tree is held to the SAME executed-evidence bar as a single run — it must produce its
  OWN `executed` evidence (its full verifier ran the suite on the whole tree) or promote only under the
  explicit no-tests policy. Enforced in BOTH the integrator decision AND the promotion authority.

## 6. Tree-hash / CAS: before → after

- **Before:** `readTreeHash` undefined (any error OR non-git) → stale-tree + `verifiedAgainst` skipped (fail-open).
- **After:** a new `isGitBacked` probe distinguishes a real git worktree from a non-git test workspace. The
  authority sets `candidate.treeIdentityRequired` and, for a git-backed candidate, **fails CLOSED** when the
  verified tree was never captured OR the live tree is unreadable (`worker.promotion.tree_identity_unavailable`).
  A genuinely non-git (in-memory) workspace is exempt, unchanged. The stale-tree/CAS binding is preserved.

## 7. REPL `/apply`: before → after

- **Before:** `mgr.promote()` direct, no `verifiedAgainst`, evaluatorId only, no manual label.
- **After:** an explicit MANUAL-UNVERIFIED authority. Still gate-walled (a deny blocks); binds
  `verifiedAgainst` (target head + scratch tree) so a drifted/moved target cannot land (closes the CAS
  bypass); emits `workspace.manual_apply` with `authorityMode: "manual-unverified"`, `operatorDirected: true`,
  `verifiedPromotion: false`, `testsCertified: false`, `semanticEvaluationAuthoritative: false`,
  `successTrustAwarded: false`. Never emits `worker.promotion`. No success trust.

## 8. Autonomous promotion requirements (authority now validates)

policy promote · gate-wall allow · semantic pass (Phase 4) · **`verificationPassed === true`** ·
**executed-test evidence acceptable** (executed, or absent under explicit policy) · **enforceable tree
identity** on git-backed candidates · stale-tree/CAS binding. Fails closed if any is unavailable/false.
Receipts: `worker.promotion` (adds `semanticEvaluationId` from Phase 9) + the new
`worker.promotion.evidence_withheld` / `worker.promotion.tree_identity_unavailable` refusals.

## 9. Files changed

**Commit 1 — authority (`fix(promotion): require executed evidence and tree identity`):**
```
src/modules/worker-model/executed-evidence.ts     NEW — executed-test-evidence policy (pure)
src/modules/worker-model/integrator.ts            remove accumulatedPass test-evidence exemption; explicit policy
src/modules/worker-model/contract.ts              WorkerTask.noTestsPolicy
src/modules/worker-model/orchestrator.ts          authority enforces verificationPassed + executed evidence +
                                                  tree identity (isGitBacked); CandidateEvidence.testEvidence/
                                                  noTestsAcceptable; PromotionCandidate.treeIdentityRequired;
                                                  3 candidate constructions thread the evidence + tree flag
src/modules/worker-model/integrator.test.ts       the accumulated exemption tests → new fail-closed contract
+ 21 test-harness files                           promoting verifier stubs now carry a real executed `test`
                                                  check (readVerifier re-derives testEvidence; a `testEvidence:
                                                  "executed"` on empty checks was clobbered to `absent`)
```
**Commit 2 — REPL boundary + conformance (`fix(repl): separate manual apply from verified promotion`):**
```
src/modules/chat/repl-workspace.ts                            manual-unverified authority class + receipt + verifiedAgainst
src/modules/worker-model/promotion-authority-conformance.test.ts  NEW — 13 conformance tests + 6 mutation guards
HANDOFF-PHASE-10-PROMOTION-AUTHORITY.md                      this file
```
The 21 harness files: orchestrator, promotion-funnel, safety-evidence, classifier-cost, model-identity,
lane-duel, semantic-contract, runtime-truth, integrator-refuter, critic-recovery-conformance,
production-wiring, kill-checkpoint, total-budget, delegation, drift-governor, approval, hermes-ikbi-contract,
complexity-timeout, batch-planner, progress-events, fixer-rescue, worker-model.cli, verifier-target
(acceptance). These are fixture updates for a genuine contract change — a promoting candidate must now carry
authentic executed-test evidence.

## 10. Tests added + mutation evidence

**13 conformance tests** (`promotion-authority-conformance.test.ts`): the pure evidence policy (A1–A2);
authority enforcement at the real `promoteCandidate` seam — executed promotes, missing/zero/unverified/absent
block, failed verifier blocks, no-tests-policy path, tree-identity fail-closed on a git-backed candidate,
non-git exempt (B1–B6); REPL manual-unverified receipt / no-worker.promotion / no-trust / gate-deny (C1–C3);
source boundary — one `workspaces.promote` caller + the authority consumes the evidence/tree gates (D1–D2).
Plus the integrator suite's rewritten C1 tests (accumulated `zero`/`unverified` now DISCARD; accumulated
`executed` promotes; `absent` promotes only under explicit policy).

**Mutation guards** — each injected, demonstrated `# fail 1`, then reverted (all 4 source files restored clean):

| Brief mutation | Regression injected | Guard |
|---|---|---|
| 1 (missing evidence → pass) | `evaluateExecutedTestEvidence` returns acceptable for non-executed | A1 |
| 2 (multi-step reuse intermediate) | restore `accumulatedPass \|\|` in the integrator gate | integrator C1 accumulated-DISCARD |
| 3 (candidate hash fails → promote) | delete the tree-identity gate | B5 |
| 4 (authoritative-tree hash fails) | delete the tree-identity gate (same gate covers verified+live tree) | B5 |
| 5 (`/apply` verified-success receipt) | rename `workspace.manual_apply` → `worker.promotion` | C1 |
| 6 (manual apply awards trust) | `successTrustAwarded: false` → `true` | C2 |
| 7 (tournament bypass executed tests) | delete the authority's executed-test gate (universal to every strategy) | B2 |
| 8 (fixer reuse source test evidence) | — structurally prevented (see §12) | Phase 6 re-verify + B2 |

## 11. Commands and exact results

```
pnpm build                              # clean (tsc strict, typechecks tests)
# focused: promotion-authority-conformance, integrator, orchestrator, promotion-funnel, safety-evidence,
#   competitive, tournament, fixer-rescue, model-identity, lane-duel, semantic-contract, runtime-truth,
#   classifier-cost, repl-apply-gatewall/managed/verified-apply  → all green
pnpm test                               # full suite
# production-config probe (isolation off, project .env): 106/111 — the SAME 5 escalation/roster expectation
#   failures the re-audit reported (they pass in the isolated suite; roster/model-order divergence, NOT
#   evidence/tree/apply — my changes do not touch escalation roster logic).
```
- `pnpm build`: **passed**. `promotion-authority-conformance.test.ts`: **13/13** (fails under the mutations above).
- `pnpm test` (full): **3628 tests, 3627 pass, 1 skip, 0 fail**. Phase 9 baseline 3613 → +15 new tests.
- Phase 1–9 conformance suites: all green (model-identity, lane-duel, promotion-funnel, semantic-contract,
  runtime-truth, fixer-lane, classifier-cost, safety-evidence, critic-recovery).

## 12. Required answers

- **Remaining authoritative-workspace-change paths:** `promoteCandidate` (autonomous, now fully evidence-gated)
  and REPL `/apply` (manual-unverified, labelled, hash-bound). No other production path changes the
  authoritative workspace. `WorkspaceManager.promote` is reachable from those two callers only.
- **Remaining promotion bypasses:** none that autonomously promote without executed evidence + tree identity.
  The tournament default replay is still git-apply-denied (IKBI-RT-003, out of scope) — it cannot reach the
  authority to promote at all.
- **Can any hash failure still disable enforcement?** No, for git-backed candidates: an unreadable verified or
  live tree fails closed. A genuinely non-git (in-memory/test) workspace has no tree by definition and is
  exempt — this is not a production git-workspace hole.
- **Can any autonomous success occur without executed-test evidence?** No — the authority blocks
  missing/zero/unverified, and `absent` only promotes under an explicit, receipted no-tests policy. Enforced
  for every strategy (normal, duel, multi-step final, tournament, competitive, legacy, experimental) because
  all route through `promoteCandidate`.
- **Can manual apply be mistaken for verified promotion?** No — `/apply` emits `workspace.manual_apply`
  (`authorityMode: manual-unverified`, `verifiedPromotion:false`), never `worker.promotion`, and awards no trust.
- **Mutation 8 (fixer reuse source evidence):** structurally prevented. Phase 6 re-verifies the repaired tree
  and the authority reads the FINAL verifier's `readVerifier(...).testEvidence` (bound to the promoted tree via
  Phase 3 stale-tree). A source candidate's evidence cannot satisfy the gate for a different (repaired) tree.
- **Phases 1–9 invariants intact?** Yes — model/attempt/lane identity, conditional peer cost, canonical
  semantic verdicts, bounded critic recovery, runtime-truth scoping, lane-pure fixer, classifier/run cost,
  SafetyAssessment authority boundary, and success-trust-only-after-promotion are all unchanged and green.
  `promoteCandidate` remains the sole autonomous `workspaces.promote` caller.

## 13. Explicitly NOT globally fixed (out of scope for Phase 10)

- IKBI-RT-003 (tournament git-apply replay), IKBI-REAUDIT-002 (attempt-wide model/lane identity in
  scout/critic/repair receipts), IKBI-REAUDIT-003 (semantic evidence-manifest / recovery substance),
  IKBI-REAUDIT-004 (invocation cost ledger), IKBI-REAUDIT-005 (runtime-truth scope), IKBI-REAUDIT-007
  (immutable semantic evidence record), IKBI-RT-007/008/009/010, IKBI-REAUDIT-008 (verified-not-promoted
  trust outcome). Documentation drift (ADJUDICATION-CORE, role order, critic-fix-loop default). The 5
  production-config roster expectation failures (IKBI-RT-009) are pre-existing and unchanged. No push/tag/PR.
```
```
