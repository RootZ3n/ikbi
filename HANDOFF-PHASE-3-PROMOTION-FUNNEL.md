# Handoff — Phase 3: Canonical Promotion Funnel (IKBI-RT-004 / IKBI-RT-005)

Date: 2026-07-10
Branch: `harness/cc-parity-and-bokahli-pilot`
Base: Phase 1 `288ad62` (model identity) → Phase 2 `4aba481` (lane-pure duel)
Scope: one canonical, evidence-bearing promotion authority for every promotion-capable strategy, plus
stale-tree binding and the experimental-completion quarantine. No promotion-architecture redesign, no
model-router/roster/critic-prompt/classifier-cost/cross-lane-fixer redesign.

## Pre-change promotion inventory

Every path that could cause authoritative success BEFORE this phase. Three code sites called the
low-level `workspaces.promote` directly; each built its own evaluation/governance and none threaded
the (already-implemented) `verifiedAgainst` stale-tree binding.

| Path | Entrypoint | Candidate id | Workspace | Det. verifier | Model critic | Concrete defect req'd | Evidence source | Stale-tree check | Policy gate | Direct promote helper | Success receipt | Trust update | Reachable by default | Bypass risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Normal / MoE | orchestrator.run terminal (was ~3862) | `task.taskId` | single | yes | yes (integrator reads it) | no | integrator decision | **none** | gate-wall + injection + approval | **yes (direct)** | run.summary only | after promote | yes | stale tree unbound |
| Duel primary | same, lane `deepseek` | `<id>:deepseek` | single | yes | yes | no | integrator | none | same | yes (direct) | run.summary | after promote | via `--tier cheap` | stale tree unbound |
| Duel peer | same, lane `mimo` | `<id>:mimo` | single | yes | yes | no | integrator | none | same | yes (direct) | run.summary | after promote | on primary non-promotion | stale tree unbound |
| Tournament | makeTournamentEngine.promote (was ~4608) | `task.taskId` | shadow | yes (shadow re-verify) | **no** | no | deterministic judge | none | gate-wall + taint | **yes (direct)** | worker.tournament | after promote | flag `IKBI_CANDIDATE_MODELS` | bypasses critic/integrator/adjudication + stale tree |
| Competitive | runCompetitive terminal (was ~4409) | `task.taskId` | N workspaces | yes | **no** | no | deterministic judge | none | gate-wall + taint | **yes (direct)** | competitive.completed | after promote | flag `IKBI_WORKER_MODEL_COMPETITIVE` | bypasses critic/integrator/adjudication + stale tree |
| Rescue / fixer | in builder/verifier flow | (part of the attempt) | shared | yes (re-verify) | via pipeline | no | re-verify | n/a (reverified) | via the owning path | no (feeds the owning path) | via owning path | via owning path | yes | cross-lane fixer model (IKBI-RT-012) |
| Legacy completion | integrator decision (default) | `task.taskId` | single | yes | yes | no | integrator | none | gate-wall | via normal path | run.summary | after promote | **default** | stale tree unbound |
| `IKBI_LEGACY_COMPLETION=off` | adjudication core authoritative | `task.taskId` | single | yes | yes | no | `decidePromotability` on a **synthesized** SafetyLedger; tautological tree check | none | gate-wall downstream | via normal path (SYNTHESIZED approving eval to override integrator) | run.summary | after promote | exact `off` | **manufactures a promote from synthesized evidence** |
| Adjudication shadow | default on | n/a | n/a | n/a | n/a | n/a | telemetry only | n/a | n/a | no | divergence receipt | no | yes | none (advisory) |

All three direct promote sites and both experimental completion modes are now funneled (below).

## Canonical candidate definition

`PromotionCandidate` (in `orchestrator.ts`): `{ taskId, attemptId, strategy, workspaceId, workspacePath,
model?, vendorLane?, verifiedTree?, targetHead? }`. `strategy ∈ {normal, duel-primary, duel-peer,
tournament, competitive}`. `attemptId` is the Phase-2 lane-distinct task id. `verifiedTree` is the
content tree hash the deterministic verifier certified.

## Canonical promotion authority

`promoteCandidate(handle, candidate, evidence, parentIdentity)` — the **sole** caller of
`workspaces.promote` (proven by a source-count conformance test = exactly 1). It:

1. refuses unless `evidence.policyPromote` AND the real `governance.allow` are both true;
2. STALE-TREE — re-reads the candidate's live tree via the injectable `readTreeHash` seam and refuses
   (recording `worker.promotion.stale_tree`) if it no longer equals `candidate.verifiedTree`;
3. binds `verifiedAgainst = {targetHead, integratedTree: verifiedTree}` so the workspace CAS also
   refuses a moved target / a landed tree ≠ the certified tree;
4. performs the one promote;
5. emits the canonical `worker.promotion` receipt carrying the full identity chain
   (`taskId, attemptId, strategy, model, vendorLane, verifiedTree, verificationPassed, semanticVerdict,
   policyPromote, gateWallAllowed, staleTreeChecked, promoted, landedRef`).

## Candidate identity / evidence-binding design

`CandidateEvidence`: `{ verificationPassed, verificationMode?, semanticKind, policyPromote, governance,
evaluation, message, rationale? }`. Every field describes THIS candidate; the authority synthesizes
nothing. `semanticKind` is classified by `classifySemanticVerdict` (pure, exported): `pass` /
`concrete-fail` (a FAIL with ≥1 concrete issue or substantive feedback) / `indeterminate` (a bare or
unparsable FAIL — never recorded as a concrete defect) / `not-evaluated` (a strategy that ran no model
critic — tournament/competitive today).

## Stale-tree mechanism

`readTreeHash(workspacePath)` (dep, default `git -C <path> rev-parse HEAD^{tree}`; `undefined` for a
non-git/in-memory workspace ⇒ the check is skipped, unchanged). The verified tree is snapshotted once,
AFTER all roles + escalation + rescue have run (so an escalated/fixed tree is what's bound), and the
authority re-reads immediately before promoting. A mismatch ⇒ fail-closed: discard the unverified work,
reject, suppress trust. Plus `verifiedAgainst` gives the workspace CAS the moved-target + certified-tree
guards (the IKBI-RT-005 primitive that already existed but was never threaded).

## Path-by-path: before → after

- **Normal / MoE / duel primary / peer** — before: direct `workspaces.promote`. after: builds a
  `PromotionCandidate` (+ `strategy` from the lane) and submits to `promoteCandidate`; stale-tree +
  canonical receipt now apply. Phase 1/2 identity + lane invariants preserved.
- **Tournament** — before: `makeTournamentEngine.promote` called `workspaces.promote` directly. after:
  the shadow winner is a SELECTED, reverified candidate submitted to `promoteCandidate` (`strategy:
  "tournament"`). It still does NOT run the model critic (`semanticKind: not-evaluated`) — the semantic
  funnel is not unified in this phase (see IKBI-RT-004 status).
- **Competitive** — before: direct `workspaces.promote` of the judged winner. after: the winner is a
  SELECTED candidate submitted to `promoteCandidate` (`strategy: "competitive"`); no model critic
  (`not-evaluated`).
- **Rescue / fixer** — unchanged mechanics: the fixer always re-verifies and its re-verified tree is
  what the authority snapshots, so pre-fix verification never authorizes post-fix promotion. Cross-lane
  fixer model (IKBI-RT-012) remains open and is NOT claimed fixed.
- **Adjudication (`IKBI_LEGACY_COMPLETION=off`)** — before: on `action==="promote"` it SYNTHESIZED an
  approving evaluation and overrode an integrator DISCARD. after: **quarantined** — it may CONFIRM a
  promote the integrator also approved (which still passes the canonical authority's real gate-wall +
  stale-tree), but when the integrator did not approve it fails CLOSED and retains the work. It can no
  longer manufacture an autonomous promote from synthesized safety facts.
- **Legacy completion (default)** — routed through the canonical authority via the normal path; legacy
  candidate production preserved, legacy promotion bypass removed.

## `IKBI_LEGACY_COMPLETION=off` final status

**Quarantined** (the brief's preferred outcome). Reachable and deterministic; it can withhold/retain
and can confirm an integrator-approved promote (which then traverses the canonical authority), but it
CANNOT autonomously promote over an integrator deny from its synthesized SafetyLedger. Authentic
safety-fact binding (wiring real drift/breach/gate facts into `decidePromotability`) is deliberately
left to a later phase; until then the mode is safe-by-quarantine, not trusted-by-authenticity.

## Trust-update ordering

Unchanged and re-verified: success trust binds to actual promotion. `overall === "success"` ⟺
`promoted === true` on the normal path; competitive maps `outcome` (success ⟺ promoted); tournament maps
`ev.promoted`. A stale-tree block sets `overall="rejected"` + `trustSuppressed=true`, so it earns no
success credit (proven by a conformance test). The canonical authority itself never touches trust —
trust is recorded by the terminal AFTER the authority returns.

## Receipt changes

New `worker.promotion` receipt (identity chain) on every promotion-capable path; new
`worker.promotion.stale_tree` on a stale-tree refusal. A promoting build's receipt count rose by one
(role receipts + run-summary + **promotion**) — one existing count test updated accordingly.

## Files changed

- `src/modules/worker-model/orchestrator.ts` — `PromotionStrategy`/`PromotionCandidate`/
  `CandidateEvidence`/`SemanticVerdictKind` types; `classifySemanticVerdict` (exported); `readTreeHash`
  dep + default; `promoteCandidate` authority (sole `workspaces.promote` caller); routed normal,
  competitive, and tournament promotes through it; `verifiedTree`/`verifiedTargetHead` capture;
  stale-tree fail-closed handling; adjudication-authoritative **quarantine**; deps `promote` type now
  carries `requestId`/`verifiedAgainst` truthfully.
- `src/modules/worker-model/orchestrator.test.ts` — updated the receipt-count test (+1 promotion
  receipt) and replaced the old "authoritative core overrides an integrator discard to promote" test
  with the Phase-3 quarantine assertion (intentional contract change per the brief).
- `src/modules/worker-model/promotion-funnel-conformance.test.ts` — **new** (10 tests).

## Tests added

Pure critic-boundary (3): bare FAIL → indeterminate; unparsable → indeterminate; concrete/pass/none.
Single-authority source invariant (1): exactly one `workspaces.promote(` call site.
Real seam (6): normal success routes through the authority + canonical receipt chain (req 1/10/13/17);
stale-tree refusal (req 14/15); trust ordering (req 16); duel primary/peer distinct ids + own verified
tree, no evidence reuse (req 3/4/5/24); selection ≠ completion — an integrator discard yields no
promotion receipt (req 20); verifiedAgainst is bound (req 12). Phase-1 (`model-identity-conformance`)
and Phase-2 (`lane-duel-conformance`) suites remain green (req 21/22/23).

## Mutation-test evidence

- Disable the stale-tree check → the stale-tree test AND the trust-ordering test fail (a mutated
  candidate would promote and earn success trust). [mutation 2, 4]
- Make a bare `FAIL` classify as `concrete-fail` → the critic-boundary test fails. [mutation 6]
- Add a second `workspaces.promote(` call anywhere → the single-authority source test fails. [mutation 1]
- Restore the synthesized-approval override in the adjudication block → the orchestrator quarantine
  test fails (it would promote over an integrator discard). [mutation 5]
- (mutation 3, peer reuses primary evidence) — the duel test binds a distinct `verifiedTree` per
  attempt; sharing one would collapse the `notEqual(verifiedTree)` assertion.
All intentional mutations were reverted before committing.

## Commands and exact results

```
pnpm build                                   # clean
# focused: promotion-funnel-conformance, orchestrator, tournament, competitive, worker-model.cli,
#          lane-duel-conformance, model-identity-conformance, fixer-rescue, interrupt-retain, total-budget
pnpm test                                    # full suite
```

- `pnpm build`: **passed**.
- New `promotion-funnel-conformance.test.ts`: **10 / 10** (fails under the mutations above).
- `orchestrator.test.ts`: **111 / 111** (incl. the updated count + quarantine tests).
- Phase 1 `model-identity-conformance`: **6 / 6**; Phase 2 `lane-duel-conformance`: **16 / 16**.
- `pnpm test` (full): **tests 3513, pass 3512, fail 0, skipped 1**. Baseline after Phase 2 was
  3503/3502/0/1; the delta is exactly the +10 new tests. No pre-existing failures, none introduced.

## Commit

ONE coherent implementation commit (the classifier feeds the authority and the quarantine feeds the
same terminal; the orchestrator.ts hunks are interdependent and cannot be cleanly hunk-split without
interactive staging). Subject: `fix(runtime): unify promotion through canonical evidence gate`. Per the
Phase 1/2 convention, this handoff is included in the same commit. Resolve the SHA with
`git log -1 --format=%H`. Not pushed, tagged, or opened as a PR.

## Remaining bypass risks

- **Semantic funnel not unified (IKBI-RT-004, PARTIAL).** Tournament and competitive winners now
  traverse the canonical PROMOTE authority (stale-tree + gate-wall + canonical receipt), but they still
  do NOT run the model critic — `semanticKind: not-evaluated`. Test-green-but-goal-wrong work selected
  by the deterministic judge can still promote in those flag-gated modes without a semantic gate. The
  PROMOTION is unified; the SEMANTIC evaluation is not. Documented, not closed.
- **Cross-lane fixer (IKBI-RT-012, OPEN).** The fixer model is not lane-filtered; its candidate/evidence
  are truthful (it re-verifies; its tree is what the authority binds), but lane purity is not global.

## Status of the audit findings

- **IKBI-RT-004** — PARTIALLY fixed. Single promotion authority + stale-tree + canonical receipt now
  apply to normal/duel/tournament/competitive (no strategy promotes directly). The unified SEMANTIC
  correctness funnel (critic on tournament/competitive winners) is NOT added in this phase.
- **IKBI-RT-005** — Materially improved. The tautological tree check is replaced by an authentic
  verified-tree binding (`verifiedTree` + `verifiedAgainst`) enforced by the canonical authority, and
  the experimental completion path is quarantined so it cannot promote from synthesized safety facts.
  The SafetyLedger is still synthesized (its facts are now inert because the real gate-wall + stale-tree
  gate every promote); fully authenticating it is left to a later phase.
- **IKBI-RT-012** — OPEN (out of scope). Cross-lane fixer model unchanged; not claimed fixed.

## Direct answers to the required questions

- **Can any strategy still claim success without canonical promotion?** No. A `worker.promotion`
  success receipt is emitted only by the authority after `workspaces.promote` lands, and it is the sole
  promote caller. A selected/verified/tournament-winner candidate that does not pass the authority
  produces no promotion and no success (proven by the "selection is not completion" test).
- **Can any strategy promote evidence from a different candidate?** No on the promote/tree axis: the
  authority binds each candidate's own `verifiedTree` and refuses a mismatch; duel primary/peer bind
  distinct trees. (The tournament/competitive SEMANTIC verdict is `not-evaluated`, i.e. absent, not
  borrowed from another candidate.)
- **Phase 1 & Phase 2 invariants intact?** Yes — model-identity (6/6) and lane-duel (16/16) suites are
  green; first-attempt promotion still incurs zero peer cost; primary and peer remain separately
  attributable through the funnel (distinct attempt ids on the `worker.promotion` receipts).
- **What is NOT globally fixed?** Lane purity (cross-lane fixer, IKBI-RT-012) and the SEMANTIC
  correctness funnel for tournament/competitive (IKBI-RT-004). Both are documented above.

## Diff hygiene

The final diff touches only `orchestrator.ts`, `orchestrator.test.ts`, and the new test file — all on
the promotion-funnel / candidate-identity / stale-tree path. No unrelated cleanup.
