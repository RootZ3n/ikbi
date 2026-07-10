# Handoff — Phase 1: Model Identity Binding (IKBI-RT-001)

Date: 2026-07-10
Branch: `harness/cc-parity-and-bokahli-pilot`
Base revision at start: `97f1523`
Scope: identity binding only. No verifier/tournament/adjudication/promotion redesign, no
`IKBI_LEGACY_COMPLETION=off` repair, no cleanup outside the touched path.

## Finding addressed

**IKBI-RT-001 — Semantic expert rental does not control the initial builder.**
Related, in-scope consequence also addressed: **IKBI-RT-002** (retries/escalation crossing the
attempt's vendor lane), limited to the parts that fall out of the single-decision fix.

## Root cause

The MoE repair added a semantically-rented model (`effectiveBuilderModel`) *alongside* the older
per-role dispatch variable (`complexityModel`) instead of replacing it. Two independent selections
existed for the same attempt:

- `effectiveBuilderModel = builderModelOverride ?? rentedExpert?.modelId ?? (large ? mid[0] : default)`
  — used for the receipt, the cost stamp, and later same-model retries.
- `complexityModel = builderModelOverride ?? (large ? mid[0] : undefined)` — **the value actually
  passed to `builderForModel`**. It never included `rentedExpert.modelId`, so a rented expert never
  reached the initial builder call; when `undefined`, the builder ran the configured default.

Consequences observed in the audit and reproduced here:
- A **hard** sub-task rented to a pro model dispatched the cheap default first; the pro was only ever
  reached via a *later failure* escalation, while the first receipt already claimed the pro ran.
- A **MiMo-lane peer** rented a MiMo model but dispatched the DeepSeek default, and the receipt
  claimed MiMo. (The DeepSeek *primary* lane looked correct only by coincidence — its default equals
  its rental.)
- Generic retry/pool-sweep model picks read the global rosters, so a lane-pinned attempt could cross
  into the other vendor's models on a retry.

## Previous execution path

```
rental → effectiveBuilderModel   (receipt / cost / retry-seed)   ─┐  two separate decisions
                                                                   ├─ could diverge
builder dispatch ← complexityModel (override ?? large ?? undefined→default) ─┘
receipt/cost ← effectiveBuilderModel        ← claims a model the builder may not have run
retry/pool  ← escalationConfig.tierModels.* ← global rosters, lane ignored
```

## New execution path

```
rental → modelDecision {model, alias, source, vendorLane, rationale}   ← ONE authoritative object
builder dispatch ← modelDecision.model            ← the rented/override/default model, verbatim
pre-flight ctx bump → NEW modelDecision (source "preflight-context-escalation")  ← recorded, lane-aware, bumps UP only
receipt/detail ← modelDecision.model + modelAlias + modelSource + vendorLane
cost           ← runCost() delta on the SAME dispatched model
retries/pool   ← laneModelsFor(roster)            ← lane-filtered (no-op when unpinned)
cheap retry    ← failedModel                       ← the exact stamped model that failed
```

`modelDecision` is created once at rental time and is only replaced by the pre-flight context-size
escalation, which is itself a recorded decision (its own source value + event + log). Nothing else
recomputes model identity after rental.

## Invariant now enforced

> rented model == dispatched model == billed model == receipt model

For the alias distinction: ikbi's roster ids **are** the provider-facing model ids (the host /
provider-model-id mapping happens one layer down in the provider registry, from this exact
`model` string), so `alias` and `model` are the same id here and both are recorded truthfully.
The builder passes `modelDecision.model` straight to `invokeModel({ model, ... })`, so no
unrequested model is ever claimed to have been dispatched.

Lane discipline (IKBI-RT-002, the part that falls out of the single decision): when
`task.moeVendorLane` is set, `laneModelsFor` filters the escalation mid pick, the pool-sweep
rosters, and the pre-flight mid pick to the attempt's lane. It is a **no-op** (returns the full
roster) when no lane is pinned, so the default single-attempt ladder is byte-unchanged. An operator
`--fallback-model` still wins over the lane pick (explicit operator intent).

## Files changed

- `src/modules/worker-model/expert-rental.ts` — exported `laneRoster` (was file-private) so the
  orchestrator's retry paths reuse the exact lane filter the rental uses. No behavior change.
- `src/modules/worker-model/orchestrator.ts` — the fix:
  - Added the `AttemptModelDecision` interface.
  - Replaced the `effectiveBuilderModel` derivation with the `modelDecision` object; added the
    `laneModelsFor` helper.
  - Deleted the parallel `complexityModel`; the builder dispatches on `modelDecision.model`.
  - Rewrote the pre-flight context-size escalation to install a **new recorded** decision, based on
    the selected model's window, bumping up only to a strictly-larger window, lane-aware.
  - Stamped `model` / `modelAlias` / `modelSource` / `vendorLane` on the builder role detail and the
    receipt; `recordRole` uses `modelDecision.model`; the aborted run-summary uses it too.
  - Lane-filtered the two `midModel` escalation picks and the pool-sweep recovery rosters.
  - The cheap same-model retry now dispatches the exact `failedModel` (== its own stamped model).
- `src/modules/worker-model/orchestrator.test.ts` — one stale comment updated (was referencing the
  deleted `complexityModel`).
- `src/modules/worker-model/model-identity-conformance.test.ts` — **new** conformance suite (below).

## Tests added

`model-identity-conformance.test.ts` drives the **real builder loop** with a recording provider and
inspects the actual orchestration → provider seam (not the pure router helper):

1. `simple × deepseek lane` — the rented base model (`deepseek-v4-flash`) is the model dispatched,
   the model in the receipt, and the model billed; alias/source recorded truthfully. (covers req.
   tests 1, 3, 4, 5)
2. `difficult × deepseek lane` — the rented pro (`deepseek-v4-pro`) is dispatched on the **first**
   request, not reached via a failed flash first, and not overwritten by the default. (tests 2, 6)
3. `simple × mimo lane` — the peer dispatches a MiMo base model end to end, never the DeepSeek
   default; every request stays in the mimo lane. (the load-bearing regression)
4. `difficult × mimo lane` — the peer dispatches the MiMo pro on the first request.
5. `retry stays in lane` — a failing MiMo-lane attempt escalates only within the MiMo lane; every
   builder request (initial + cheap retry + pool sweep) is a mimo model. (test 7)
6. `pre-dispatch failure (dirty repo)` — the run is rejected before any dispatch; **no** builder
   role receipt is written, so nothing falsely claims the model executed. (test 8)

Regression value verified: temporarily re-pointing the dispatch at the configured default (the old
bug) makes tests 2, 3, 4, 5 **fail** while 1 and 6 pass — exactly matching the audit's description
(the DeepSeek primary is "correct by coincidence", the MiMo peer and hard tasks are not).

## Commands run

```
pnpm build                                         # clean (tsc strict, typechecks tests)
# focused (new state root, dev keys, unset operator/worker tokens):
node --import tsx --test \
  model-identity-conformance expert-rental orchestrator worker-model.cli tournament \
  competitive production-wiring production-defaults context-preflight fixer-rescue \
  total-budget drift-governor  (+ model-router/router)
pnpm test                                          # full suite
```

## Test results

- `pnpm build`: **passed**.
- Focused architecture suite (13 files incl. the new one): **255 / 255 passed**.
- New conformance suite alone: **6 / 6 passed**; and it **fails 4/6 when the old dispatch is
  re-introduced** (guard confirmed meaningful).
- `pnpm test` (full): **tests 3487, pass 3486, fail 0, skipped 1**. Baseline before this phase was
  3481/3480/0/1; the delta is exactly the +6 new tests. No pre-existing failures were observed, and
  none were introduced.

## Commit

Single implementation commit, subject: `fix(orchestrator): bind expert rental to executed model`
(the tip of `harness/cc-parity-and-bokahli-pilot` after this phase; resolve the SHA with
`git log -1 --format=%H`). This handoff is included in that same commit, so no separate
documentation-only commit was necessary. Not pushed, tagged, or opened as a PR.

## Remaining risks / paths still capable of misattribution

These are **out of this phase's scope** (they are identity concerns elsewhere, tracked by other
audit findings) and are called out honestly rather than silently:

- **Fixer model (IKBI-RT-012).** The last-mile fixer and the verifier-fail fixer still dispatch
  `config.fixerModel` (deliberately a *different* model — "deepseek builds, mimo-v2.5-pro fixes").
  That dispatch is internally truthful (it stamps the model it runs), but it is **not lane-filtered**,
  so a lane-pinned attempt's fixer pass can use the other vendor's model. Left intact because it is a
  deliberate cross-model repair design and lives under the fixer-receipting finding, not identity
  binding. It never misattributes *which* model ran; it only crosses the lane.
- **Tournament / competitive paths (IKBI-RT-004).** These early-return before the normal role path
  and own their own candidate dispatch (`spec.model` / `competitiveModelList`). They are truthful
  about the candidate model they run, but they do **not** flow through `modelDecision` and were
  explicitly out of scope for this phase.
- **HTTP / batch surfaces (audit row).** They call `createProductionWorker` with a bare task and no
  MoE/lane, so `modelDecision` resolves to `source: "default"` there — correct and truthful, but the
  cheap-tier architecture is simply not exercised on those surfaces (unchanged by this phase).
- **Advisory calls outside worker costing (IKBI-RT-011).** The classifier call still runs before the
  costing engine exists (a ~20-token call). Its spend is not folded into the attempt cost ledger.
  Unchanged; separate finding.

## Status of IKBI-RT-001

**Fully fixed** for the normal role path (the default production build path): the semantically-rented
expert now controls the initial builder dispatch, and receipt/cost/retry all derive from that one
recorded decision. The invariant holds through the pre-flight escalation and the cheap same-model
retry, and lane discipline (IKBI-RT-002) holds across escalation + pool sweep on that path.

Not claimed fixed: the tournament/competitive candidate paths and the cross-lane fixer model, which
are separate findings (IKBI-RT-004, IKBI-RT-012) and were explicitly excluded from this phase.
