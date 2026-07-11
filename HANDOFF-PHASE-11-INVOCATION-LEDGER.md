# HANDOFF — Phase 11: Attempt-Scoped Invocation Ledger (IKBI-REAUDIT-002 / -004)

**Branch:** `harness/cc-parity-and-bokahli-pilot` · **Status:** complete, committed, NOT pushed
**Verified start:** HEAD `5ee17be`, 2 commits ahead of `origin` (Phase 10). Clean tree; pre-existing untracked
(`.claude/`, both audit MDs, the `.tgz`, `scripts/ui-verify/package-lock.json`) left untouched.
**Result:** `pnpm build` clean · `pnpm test` = **3642 tests, 3641 pass, 1 skip, 0 fail** (Phase 10 baseline 3628 → +14) · production-config probe **111/111**.

## Central invariant

> Execution identity — which model/provider actually ran, in which vendor lane, for which role/stage, and
> what it cost — comes from the ACTUAL dispatched invocation (the provider RESPONSE), never from an earlier
> selection, a role default, a fallback intention, or a later receipt constructor.

## 1. Root cause

- **IKBI-REAUDIT-004 (cost):** `makeCostingEngine` accumulated `r.cost?.usd ?? 0` — the SERVING attempt only
  (a charged FAILED attempt in `response.attempts` was lost) — and treated missing cost as zero; the classifier
  and frontier-consult used the RAW provider bypassing the wrapper; `costPartial` keyed only on the classifier.
- **IKBI-REAUDIT-002 (identity):** the attempt decision governed only the first builder; scout/critic weren't
  lane-filtered; the iterative & critic-fix loops called `builderFor()` (global default) not `modelDecision`;
  `laneRoster` fell back to the FULL roster when a lane was empty (a cross-lane hole); `dispatchRole` stamped
  `singleBuilderModel` on every competitive/tournament role; `recordRole`/`run.summary` stamped the SELECTED
  model, never the served one.

## 2. Complete provider-call inventory (reconciled from 3 read-only subagents)

| Path | Dispatch seam (before) | In ledger now? | Lane (before → after) | Receipt model source |
|---|---|---|---|---|
| Semantic classifier | RAW `invokeModel` (2231) | **yes** (`recordExternal`, lane-neutral) | n/a | classifier model (unchanged) |
| Builder (normal/duel) | costed engine | **yes** (lane-enforced) | lane-pure → lane-pure | `modelDecision.model` (main loop) |
| Scout | costed engine, `driverModel()` | yes | not lane-aware → **task-level lane-neutral** (documented) | none stamped |
| Critic + structured recovery | costed engine, `criticModel()` | yes | not lane-aware → **task-level lane-neutral** (documented) | evaluator model (unchanged) |
| Iterative fix loop | `builderFor()` global default | yes | **cross-lane → lane-pure (`modelDecision.model`)** | attempt model |
| Critic-fix loop | `builderFor()` global default | yes | **cross-lane → lane-pure (`modelDecision.model`)** | attempt model |
| Escalation / pool sweep | costed engine, `laneRoster` | yes | lane-filtered (empty-lane now fail-closed) | swap model |
| Frontier consult | RAW provider + `addRunCost` | **yes** (`recordExternal`) | in-lane | consult model |
| Dedicated fixer | costed engine, `laneFixerModel` | yes | lane-pure (Phase 6) | fixer model (unchanged) |
| Tournament/competitive roles | costed engine via `dispatchRole` | yes (coarse ctx) | strategy-scoped | **actual `detail.model` (was `singleBuilderModel`)** |
| Peer attempt | separate `orchestrator.run` | its own ledger | lane-pure (Phase 2) | its own summary |
| Final multi-step verify | separate `orchestrator.run` (unpinned) | its own ledger | still unpinned (documented) | its own summary |

Every provider call inside a single `orchestrator.run` now flows through the ledger — either the ledger's
`engine.invokeModel` (all roles) or `recordExternal` (the raw classifier/consult). No raw `invokeModel` remains
in the run's cost path.

## 3. The invocation ledger (`invocation-ledger.ts`)

`InvocationLedger` is the universal dispatch seam. `engine.invokeModel` (used by every role) records ONE
immutable `InvocationRecord` per call; `recordExternal` folds a raw-provider call (classifier/consult).

- **`InvocationRecord`:** invocationId, runId, taskId, attemptId, candidateId/tree, role, stage, strategy,
  requestedAlias, resolvedModel, provider, providerModelId, vendorLane, modelDecisionSource, retryKind,
  parentInvocationId, requestOrdinal, dispatchedAt/completedAt, **status**, usage, **costUsd**, **costStatus**,
  failureClass, **laneViolation**. `resolvedModel`/`provider` come from the RESPONSE (execution truth).
- **Lifecycle statuses:** dispatched / succeeded / provider-rejected / transport-failure / timeout /
  content-filtered / context-window / interrupted / cancelled / partial / unknown-terminal. A SELECTION is
  never a record; a PRE-dispatch/thrown failure records a failure (never a "succeeded" invocation).
- **`chargedCostOf`:** SUMS every `response.attempts[].costUsd` (a failed attempt that charged tokens counts —
  `response.cost` is only the serving attempt); no attempts → `response.cost.usd`; any unknown → `unavailable`.
  Cost statuses: `measured` / `measured-zero` (a real zero-priced call ≠ no-call) / `unavailable`.
- **`withContext(ctx, fn)`:** ambient context (role/stage/attempt/lane), nesting-safe (save/restore). Set
  around each SEQUENTIAL dispatch (competitive/tournament candidates run sequentially → no interleaving).
- **Cost/budget/status DERIVE from the unique records:** `cost()` = Σ measured records (each counted once);
  `costStatus()` = `partial` when ANY accounted invocation's cost is unknown (not only the classifier);
  `invocationCount()`, `unknownCosts()`, `laneViolations()`. Budget is enforced on cumulative charged cost.

## 4. Decision vs execution identity + receipts

The `AttemptModelDecision` is the SELECTION; the ledger records what actually happened at dispatch — there is
no second identity object that can disagree (the ledger consumes the decision as `requestedAlias`/`modelDecisionSource`
and records the served model separately). Derived:
- **`worker.run.summary`** now stamps the **executed** builder model (`runLedger.lastFor("builder").resolvedModel`),
  `costStatus`/`invocationCount`/`unknownCostCount` from the ledger (was `singleBuilderModel` + classifier-only status).
- **`dispatchRole` → `recordRole`** stamps the role's **actual** `detail.model` (was `singleBuilderModel` for every
  competitive/tournament role); a role with no model records none.
- **`worker.classifier`** is now also a ledger record (lane-neutral, task-level).

## 5. Attempt-wide lane identity + empty-lane

- **Iterative & critic-fix repair** now dispatch `modelDecision.model` (the attempt's lane-pure model), closing
  the two HIGH cross-lane holes.
- **`laneRoster`** returns the filtered list (**empty** if no match) — it NEVER silently falls back to the full
  roster. `laneHasModels` exposes the check. A rental on an empty lane returns the explicit operator `fallback`,
  not a cross-lane borrow.
- **Empty-lane config guard:** a configured attempt lane with no valid model (neither the decided model nor any
  worker-tier model is in it) fails the attempt CLOSED before dispatch — `worker.lane_config_error` receipt,
  `outcome: "rejected"`, no duel/fixer/promotion (not a candidate defect).
- **Scout & critic** run the configured driver/critic model and are classified **task-level lane-neutral** (an
  honest, documented classification — analysis/judgment are not lane-bound generation). The BUILDER is the
  lane-enforced generation role; a served builder model outside the lane is flagged `laneViolation` in the ledger
  and surfaced on the summary. This is NOT a hidden crossing — it is recorded and observable.

## 6. Production roster / the 5 probe failures

The 5 `106/111` failures were all escalation-mechanics tests that hard-coded the built-in DEFAULT roster ORDER
(`deepseek-v4-flash` worker[0], `mimo-v2.5-pro` mid[0]); under the deployed `providers.json` the router
cost-sorts to `mimo-v2.5` / `deepseek-v4-pro`. These were **stale, non-hermetic test expectations, not
production bugs** — the router correctly cost-ranks. Fix: (a) a new injectable `deps.escalationTierModels`
(production still uses the deployed `escalationConfig.tierModels`); the orchestrator test `baseDeps` pins a
deterministic roster so escalation tests are identical in the isolated runner AND the probe; (b) two
worker-tier assertions relaxed from an exact vendor name to **tier membership** (which vendor a deployment's
cost-sorted roster ranks first is deployment-dependent; the test's contract is the escalation mechanics + tier
membership). Probe now **111/111**. Metadata-driven capability derivation (beyond the roster prefix convention)
was NOT redesigned (out of scope — "do not redesign semantic routing policy").

## 7. Cost / budget behavior

`runCost()` = `runLedger.cost()` = Σ unique measured records (incl. charged failed attempts). Missing usage or
price → `unavailable` → aggregate `partial`; a real zero-priced call is `measured-zero` (≠ no-call). Budget is
enforced on the ledger's cumulative charged cost (classifier + consult fold via `recordExternal` inside the run
try, so a tiny-cap trip is handled by the abort path). One invocation is counted exactly once; role receipts are
not separately summed (the ledger holds the cost). Phase 10 promotion/test-evidence/tree rules are untouched;
provider execution evidence and executed-TEST evidence remain distinct.

## 8. Files changed

**Commit 1 — ledger + seam + attempt-wide lane identity:**
```
src/modules/worker-model/invocation-ledger.ts   NEW — InvocationRecord + InvocationLedger + chargedCostOf
src/modules/worker-model/orchestrator.ts         makeCostingEngine → ledger-backed; classifier/consult recorded;
                                                 run.summary derived from ledger; main-loop withContext;
                                                 iterative/critic-fix lane-pure; empty-lane guard; dispatchRole
                                                 records the executed model; injectable escalationTierModels
src/modules/worker-model/expert-rental.ts         laneRoster fail-closed (empty≠full-roster) + laneHasModels
```
**Commit 2 — conformance tests + probe hermeticity + handoff:**
```
src/modules/worker-model/invocation-ledger-conformance.test.ts  NEW — 14 retained conformance/guard tests
src/modules/worker-model/orchestrator.test.ts                   baseDeps pins escalation roster; 5 probe tests hermetic
src/modules/worker-model/expert-rental.test.ts                  empty-lane fallback test → new fail-closed contract
HANDOFF-PHASE-11-INVOCATION-LEDGER.md                           this file
```

## 9. Retained tests + mutation evidence

**14 retained conformance tests** (`invocation-ledger-conformance.test.ts`): charged-cost truth (failed-attempt
summed, missing→unavailable, measured-zero); the ledger (one record per dispatch, resolved-from-response identity,
pre-dispatch failure records a failure, partial aggregate, unique retry ids, lane-violation flag, budget, external
folding); `laneRoster` fail-closed; and the real orchestrator seam (summary derives cost/model from the ledger;
empty-lane → `worker.lane_config_error` fail-closed). These are PERMANENT guards, not throwaway.

Mutation evidence (each injected, guard demonstrated `# fail 1`, then reverted — files restored clean):
| Regression | Guard |
|---|---|
| `chargedCostOf` ignores attempts (serving cost only) | A1 |
| missing cost → measured zero | A2 |
| `laneRoster` restores the full-roster fallback | C1 |
| `run.summary` reverts to `singleBuilderModel` | D1 |
(Plus the in-file guards B1–B8 cover double-count, selected-vs-executed identity, unknown→partial, lane
violation, budget, external folding.)

## 10. Commands and results

```
pnpm build                              # clean (tsc strict)
node --import tsx --test invocation-ledger-conformance.test.ts   # 14/14
pnpm test                               # 3642 tests, 3641 pass, 1 skip, 0 fail (Phase 10 baseline 3628 → +14)
# production-config probe (isolation off, project .env): 111/111 (was 106/111)
```
Focused suites green: classifier-cost, total-budget, model-identity, lane-duel, fixer-lane, expert-rental,
orchestrator, worker-model.cli, promotion-authority (Phase 10), safety-evidence (Phase 8), critic-recovery
(Phase 9), and all Phase 1–10 conformance suites. No paid provider calls. No sandbox/permission failures in the
local run (all assertion-level).

## 11. Required answers

- **Is every provider call inside `orchestrator.run` ledgered?** Yes — all role calls via `engine.invokeModel`,
  plus the classifier and frontier-consult via `recordExternal`. No raw `invokeModel` remains in the run cost path.
- **Can any execution receipt name a model that did not run?** The run summary and the competitive/tournament role
  receipts now derive the EXECUTED model (from the ledger / the role's own `detail.model`); the classifier records
  its dispatched model. **Remaining:** per-role builder/critic receipts on the escalation/retry sub-paths still
  stamp their selected model (they match what ran, but are not yet re-derived from the ledger record) — documented
  boundary; NOT globally re-sourced.
- **Can any role cross lanes inside an attempt?** The lane-bound GENERATION role (builder, incl. iterative/critic
  repair) is lane-pure; empty-lane fails closed; `laneRoster` never borrows. Scout and critic are classified
  task-level lane-neutral (recorded, observable via `laneViolation` if tagged) — a deliberate documented boundary,
  not a hidden crossing.
- **Phases 1–10 intact?** Yes — all conformance suites green: model/attempt/lane identity, conditional peer cost,
  semantic verdicts, bounded critic recovery, runtime-truth scoping, lane-pure fixer, classifier/run cost,
  SafetyAssessment non-authority, success-trust-only-after-promotion, and every Phase 10 promotion-authority
  invariant (executed-test evidence, tree identity, `promoteCandidate` sole authority, `/apply` manual-unverified).

## 12. Explicitly NOT globally fixed (remaining boundaries)

- **Coarse context on sub-dispatches:** the main role loop and `dispatchRole` set ledger context, but the
  fixer/escalation/cheap-retry/critic-fix sub-dispatches are recorded under the shared engine's ambient context
  (correct model/provider/cost, coarser role/stage tag). A fully per-sub-dispatch `withContext` wrap is a follow-up.
- **CLI cross-attempt cost:** each attempt (primary/peer, multi-step step, tournament/competitive candidate) has
  its OWN ledger; the CLI still returns the winning attempt's cost — summing primary+peer+losing-attempt cost at
  the CLI surface is NOT done (a CLI-surface change), documented.
- **Per-receipt invocationId referencing:** not every execution receipt yet carries its `invocationId` link; the
  summary/classifier/competitive-role model derivation is done, broader referencing is a follow-up.
- **Metadata-driven lane/capability derivation:** lane membership remains the roster prefix convention (not
  resolved provider metadata) — out of scope ("do not redesign semantic routing policy").
- **Final multi-step task lane:** the final verify pass remains unpinned (writeScope none; no generation) —
  documented; carrying the lane into it is a follow-up.
- Out of scope by the brief: IKBI-RT-003 (tournament git-apply), IKBI-REAUDIT-003 (semantic recovery substance),
  -005 (runtime-truth scope), -007 (immutable semantic record), RT-007/008/010, -008 (verified-not-promoted trust),
  CLI cognition accounting, Abina, public hardening. No push/tag/PR.
```
```
