# HANDOFF — Phase 11B: The Invocation Ledger as Execution Authority (IKBI-REAUDIT-002 closure)

**Branch:** `harness/cc-parity-and-bokahli-pilot` · **Status:** complete, committed, NOT pushed
**Verified start:** HEAD `5b56dac`, 4 commits ahead of origin (Phase 10 `4820c27`/`5ee17be` + Phase 11 `7b17db8`/`5b56dac`). Clean tree; pre-existing untracked left untouched.
**Result:** `pnpm build` clean · `pnpm test` = **3647 tests, 3646 pass, 1 skip, 0 fail** (Phase 11 baseline 3643 → +4) · production-config probe **111/111**.

## Why this closure was required

The Phase 11 handoff honestly documented boundaries that kept the ledger from being the universal execution
AUTHORITY: the critic was classified task-level lane-neutral; `laneViolation` could OBSERVE rather than PREVENT
an illegal attempt-bound dispatch; the final multi-step executor lacked explicit lane identity; and some
execution receipts did not reference their invocation records. Phase 11B closes these.

## 1. Lane-neutral roles: before → after

| Role | Before (Phase 11) | After (Phase 11B) |
|---|---|---|
| Classifier | task-level lane-neutral | unchanged — genuinely pre-attempt (routing), lane-neutral |
| General scout | task-level lane-neutral | unchanged — general pre-attempt analysis, lane-neutral (documented, tested) |
| Builder (+ iterative/critic-fix repair) | attempt-bound, lane-enforced | unchanged (Phase 11) |
| **Candidate critic** | **task-level lane-neutral** | **ATTEMPT-BOUND, lane-enforced** — lane-valid model + ledger context lane |
| **Critic structured recovery** | inherited task-level critic | **in-lane by construction** (reuses the lane-valid critic model) |
| **Post-fixer / escalation critic** | task-level | **attempt-bound (same `criticFor(laneCriticModel)`)** |
| Final multi-step executor | unpinned task-level | **explicit finalization attempt bound to the build lane** |

## 2. Critic lane behavior

The candidate critic is now attempt-bound. `resolveLaneCriticModel`: for a lane-pinned attempt, use the
operator/configured critic when it is IN-LANE; else the lane's mid/pro-tier model (`laneRoster(mid, lane)[0]`);
`undefined` on a lane-pinned attempt means the lane has no valid critic → the attempt fails CLOSED (below).
`criticFor(laneCriticModel)` passes it into `createCritic({ modelOverride })`; `critic.ts` uses
`deps.modelOverride ?? task.criticModelOverride ?? criticModel()`. The critic's ledger context carries the
attempt lane, so a requested out-of-lane critic model is BLOCKED pre-dispatch and a served out-of-lane model
is an execution-identity violation. This applies to the primary/peer/fix-loop/escalation critics uniformly
(all route through `criticFor(laneCriticModel)`). Competitive/tournament attempts are not lane-pinned
(`moeVendorLane` unset) → their critic uses the configured critic, unchanged.

## 3. Critic-recovery lane behavior

Bounded structured-output recovery (Phase 9) reuses the CRITIC request's model (`buildRecoveryRequest({ model:
request.model })`). Since the critic now runs the lane-valid model, recovery is in-lane by construction, under
the same lane-enforced ledger context — a recovery can never cross the attempt lane.

## 4. Scout classification

The general per-attempt scout remains task-level lane-neutral: it analyzes the repo/goal (shared understanding),
runs the configured driver model, and is NOT blocked by lane enforcement (test P4 proves a lane-pinned run still
completes with the scout unenforced). There is no attempt-specific/candidate scout in the current architecture;
if one is added it must carry the attempt id + lane (documented). This is an honest classification, not a hidden
crossing — the scout is not a candidate-generation or candidate-judgment role.

## 5. Final multi-step executor

The final `:verify:<lane>` task now carries `moeVendorLane` — an explicit finalization attempt bound to the
build's lane (it reuses the shared workspace; it is not a new candidate, so no separate attempt lineage is
needed). Its candidate critic is lane-enforced; a lane with no valid critic fails it closed. It cannot silently
borrow another lane. Phase 10 executed-test evidence remains separate and required for the final tree.

## 6. Lane-violation enforcement (the core change)

`InvocationLedger.invoke` now ENFORCES, not just observes:
- **PRE-dispatch:** an attempt-bound call (`vendorLane` set) whose REQUESTED model is out-of-lane
  (`!laneMember`) throws `LaneViolationError("pre-dispatch")` — records a `lane-blocked` state, makes NO
  provider call, incurs NO cost, and is NOT counted as an executed invocation.
- **POST-dispatch:** a SERVED model belonging to a KNOWN OTHER vendor lane (`servedOutOfLane` — a genuine
  cross-vendor crossing, distinct from a generic/unknown stub model) records `execution-identity-violation`,
  PRESERVES any charged cost (truthful), increments `executionIdentityViolations()`, and throws so the caller
  fails closed — the response is NOT valid candidate evidence and cannot become promotion evidence.
`laneViolation` remains a defensive record field + a test assertion; it is no longer the ONLY response.

## 7. Out-of-lane provider-response behavior

A provider that returns an out-of-lane identity for an attempt-bound call is classified
`execution-identity-violation`: the ledger keeps the cost, marks the truthful terminal state (never rewritten
to look compliant), the caller throws (role fails), and the run cannot autonomously promote on that role's
output. `servedOutOfLane` is gated to a KNOWN other lane so a stub/novel model never false-positives.

## 8. Execution-receipt inventory + linkage

| Receipt | Model source (after) | invocationId? |
|---|---|---|
| `worker.role.builder` / `.critic` / `.*` (main loop) | ledger `requestedAlias` (dispatched == receipt, Phase 1) | **yes** (`ledger.lastFor(role)`) |
| `worker.role.*` (cheap-retry / escalation / swap) | selected retry model | **yes** (`ledger.lastFor("builder")`) |
| `worker.run.summary` | executed builder model + cost/costStatus/invocationCount (from ledger, Phase 11) | derives from ledger (multi-invocation) |
| `worker.classifier` (Phase 7) | classifier model; also a ledger record | classifier invocation id |
| dispatchRole roles (competitive/tournament) | actual `detail.model` (Phase 11) | **no** — documented remaining |
| `worker.critic_recovery` (Phase 9) | recovery model | recovery-internal id (not the ledger id) — documented |
| `worker.fixer` (Phase 6) | fixer model | **no** — documented remaining |

Role receipt model + id derive from the ledger (`requestedAlias` = the DISPATCHED model, preserving Phase 1's
`dispatched == receipt`; the SERVED model lives on the invocation record and a divergence is the lane-violation
case). Decision receipts (`worker.classifier` records intent + selected expert) remain non-execution records.

## 9. Files changed

```
src/modules/worker-model/invocation-ledger.ts    LaneViolationError + pre/post lane enforcement;
                                                 lane-blocked / execution-identity-violation statuses;
                                                 servedOutOfLane dep; executionIdentityViolations();
                                                 invocationCount excludes lane-blocked
src/modules/worker-model/orchestrator.ts          laneCriticModel resolution; criticFor(laneModel);
                                                 empty-lane guard also requires a lane-valid critic; critic
                                                 ledger context lane-bound; servedOutOfLane wired
                                                 (KNOWN_VENDOR_LANES); role receipts derive model + invocationId
src/modules/worker-model/critic.ts                CriticDeps.modelOverride (lane-valid critic wins)
src/modules/worker-model/cli.ts                   final multi-step task carries moeVendorLane
src/modules/worker-model/invocation-ledger-conformance.test.ts   B6 (post-throw) + B6b (pre-block) enforcement
src/modules/worker-model/phase11b-lane-authority-conformance.test.ts   NEW — 4 real-seam tests
HANDOFF-PHASE-11B-LEDGER-AUTHORITY.md             this file
```

## 10. Tests added + mutation evidence

**Retained tests:** invocation-ledger-conformance B6/B6b (post-dispatch out-of-lane THROWS + preserves cost;
pre-dispatch out-of-lane BLOCKED, no call/cost/executed-record); phase11b-lane-authority-conformance P1–P4
(critic attempt-bound + lane-valid + receipt→invocation; builder receipt→invocation + dispatched model; no
lane-valid critic fails closed; general scout lane-neutral). Plus the existing Phase 11 ledger/cost guards.

Mutation evidence (each injected, guard demonstrated `# fail 1`, then reverted — files restored clean):
| Regression | Guard |
|---|---|
| critic restored to lane-neutral (`criticFor()` drops the lane model) | P1 |
| `laneViolation` observe-only (post-dispatch does not throw) | B6 |
| role receipt omits its invocation id | P1 |
| empty-lane guard no longer requires a lane-valid critic | P3 |

## 11. Commands and results

```
pnpm build                                          # clean
node --import tsx --test phase11b-lane-authority-conformance.test.ts   # 4/4
node --import tsx --test invocation-ledger-conformance.test.ts         # 15/15
pnpm test                                           # 3647 tests, 3646 pass, 1 skip, 0 fail (Phase 11 3643 → +4)
# production-config probe (isolation off, project .env): 111/111
```
Focused suites green: invocation-ledger, model-identity, lane-duel, classifier-cost, total-budget, critic,
critic-recovery, fixer-lane, expert-rental, orchestrator, worker-model.cli, promotion-authority (Phase 10),
and all Phase 1–10 conformance suites. No paid provider calls; no sandbox/permission failures (all
assertion-level in the local run).

## 12. Required answers

- **Is every candidate-affecting provider call attempt-bound?** The builder (+ iterative/critic-fix repair) and
  the candidate critic (+ its recovery) are attempt-bound and lane-enforced. The classifier and general scout are
  pre-attempt task-level lane-neutral (classifier = routing; scout = general analysis) — a defensible, tested
  classification. Competitive/tournament candidates are not lane-pinned by design.
- **Can any attempt-bound role cross lanes?** No — a requested out-of-lane model is blocked pre-dispatch; a
  served out-of-lane model is an execution-identity violation that throws; an empty/critic-less lane fails the
  attempt closed. Lane-bound: builder, iterative/critic-fix repair, candidate critic + recovery, final executor.
- **Can any execution receipt tell a story different from the ledger?** Role receipts (`worker.role.*`) + the run
  summary derive model + invocation id from the ledger. **Remaining:** `worker.critic_recovery`, `worker.fixer`,
  and competitive/tournament dispatchRole role receipts carry the correct executed MODEL but not yet the ledger
  invocation ID (documented below).
- **Is Phase 11 now fully confirmed or still partial?** The core authority claim is now confirmed for the
  attempt-bound candidate roles (builder/critic/repair/final) — lane crossing is PREVENTED, not observed, and the
  primary role receipts derive from the ledger. Remaining receipt-id linkage on the secondary receipts is a
  documented follow-up (below).
- **Phases 1–10 intact?** Yes — all conformance suites green: promotion authority (executed-test evidence, tree
  identity, `promoteCandidate` sole authority, `/apply` manual-unverified), model/attempt/lane identity,
  conditional peer cost, semantic verdicts, bounded critic recovery, runtime-truth scoping, lane-pure fixer,
  classifier/run cost, SafetyAssessment non-authority, success-trust-only-after-promotion.

## 13. Explicitly NOT globally fixed (remaining boundaries)

- **Receipt→invocation id on secondary receipts:** `worker.critic_recovery`, `worker.fixer`, and
  competitive/tournament dispatchRole role receipts derive the executed MODEL correctly but do not yet stamp the
  ledger invocation ID (they carry role-internal ids). Threading the ledger into `dispatchRole` + the fixer/
  recovery receipt sites is a follow-up.
- **Coarse sub-dispatch context:** fixer/escalation/cheap-retry sub-dispatches record correct model/provider/cost
  under the shared engine's ambient context (coarser role/stage than the main loop's `withContext`).
- **Attempt-specific scout:** none exists in the current architecture; the general scout is lane-neutral by
  design. If a candidate-scout is added it must be attempt-bound + lane-enforced.
- **`servedOutOfLane` scope:** the known vendor lanes are the cheap-tier duel pool (`deepseek`/`mimo`); a novel
  vendor lane's cross-crossing would not be flagged (a generic model is deliberately not a violation).
- Out of scope by the brief: IKBI-RT-003 (tournament git-apply), IKBI-REAUDIT-003/005/007, RT-007/008/010,
  -008 (verified-not-promoted trust), CLI cross-attempt cost summation, CLI cognition accounting, Abina, public
  hardening. No push/tag/PR.
```
```
