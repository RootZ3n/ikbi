# Handoff — Phase 2: Lane-Pure Conditional Duel (IKBI-RT-002)

Date: 2026-07-10
Branch: `harness/cc-parity-and-bokahli-pilot`
Base revision at start: `288ad62` (Phase 1 — model-identity binding)
Scope: lane discipline + the duel-on-failure trigger. No promotion-architecture redesign, no
tournament/competitive/adjudication/verifier/runtime-truth repair.

## Definition of an attempt

An **attempt** is one `orchestrator.run(task)` invocation for a single vendor lane. It **begins at
model rental** — the moment the authoritative `AttemptModelDecision` is created — which is the
narrowest start that still gives a stable identity before any provider call, so even a pre-dispatch
abort is attributable. An attempt has:

- **Stable identity** = its `task.taskId`. A duel's primary and peer are now given **lane-distinct**
  ids (`<id>:deepseek`, `<id>:mimo`), so their receipts, costs, and run summaries never blur into one.
- **One authoritative model decision at any instant** (`AttemptModelDecision`), replaced only by the
  pre-flight context escalation, which is recorded (see below) — never by a silent recompute.
- **One vendor lane after dispatch begins** (`modelDecision.vendorLane`). Every escalation, pool
  sweep, retry, and the operator fallback stay inside it.
- **Separately attributable** provider calls, cost, workspace/candidate, and terminal outcome.

Escalations/retries/pool-sweeps are **in-attempt, recorded sub-decisions** (they keep the lane and
emit their own `worker.escalation.*`/`worker.cheap_retry` receipts with the actual model). They are
NOT new attempts and must never masquerade as a peer duel. The **peer** is the only new attempt.

## Complete lane-changing-path inventory

| Path | Same/new attempt | Same/cross lane (after Phase 2) | Recorded | Cost truthful | Receipt distinguishes | Runs after promote? | In scope P2 |
|---|---|---|---|---|---|---|---|
| Pre-flight context escalation | same (recorded replacement) | same lane (lane-aware mid pick) | ✅ event+log+`worker.model_decision` `phase:preflight-replacement` | ✅ | ✅ | no | ✅ (recording added) |
| Same-model cheap retry | same | same (dispatches the exact failed model) | ✅ `worker.cheap_retry` | ✅ | ✅ | no | ✅ (P1) |
| Model-ladder escalation (`midModel`) | same | same lane (`laneFallbackModel ?? laneModelsFor(mid)`) | ✅ `worker.escalation.retry` | ✅ | ✅ | no | ✅ |
| Pool sweep (`decideRecovery`) | same | same lane (lane-filtered rosters + in-lane `requestedModel`) | ✅ | ✅ | ✅ | no | ✅ |
| Semantic reclassification | n/a (classifier runs once, pre-dispatch) | sets the lane's rental | ✅ decision receipt | — | ✅ | no | ✅ (P1) |
| Operator `--fallback-model` | in-attempt escalation pick | **in-lane only**; cross-lane deferred to peer | ✅ | ✅ | ✅ | no | ✅ (this phase) |
| Duel peer attempt | **new attempt** (new id/decision/workspace) | opposite lane | ✅ separate receipts | ✅ separate | ✅ distinct id | **no** (gated on primary non-promotion) | ✅ |
| Fixer / rescue model (`config.fixerModel`) | in-attempt rescue | **may cross lane** (deliberate cross-model repair; IKBI-RT-012) | logged, not a role receipt | folded into run cost | partially | no | ❌ out of scope — see "Remaining" |
| Tournament / competitive candidate | own early-return funnel | own candidate models | own path | own | own | own gate | ❌ out of scope (IKBI-RT-004) |
| Provider failure fallback (raw throw) | none — no result produced | n/a | error surfaces | n/a | n/a | n/a — never dueled | ✅ (test 8) |
| Parser / malformed-output recovery | in-attempt (builder/critic retry) | same lane | ✅ | ✅ | ✅ | no | ✅ (never dueled unless it yields a real candidate-rejection) |
| Hard-coded default substitution | folded into `AttemptModelDecision` `source:default` | the attempt's lane | ✅ | ✅ | ✅ | no | ✅ (P1) |

## Old duel trigger

```ts
result = await runOneAttempt("deepseek");
if (duelEnabled && result.outcome !== "success") { /* run mimo peer */ }
```

`outcome !== "success"` fired the peer for **every** non-promotion: a dirty repo, a drift block, a
gate-wall veto, an operator approval rejection, an injection block, an unverifiable target, a kill,
and a promote conflict — none of which a different vendor can fix. Two vendor lanes could burn cost
on a dirty repo; an operator's approval veto could still spend a peer.

## New explicit duel trigger

`WorkerResult.nonPromotion = { class, duelEligible }` is now set at every terminal. The CLI uses a
pure policy:

```ts
export function primaryWarrantsPeer(r) {
  if (r.outcome === "success") return false;              // promoted → never a peer
  if (r.nonPromotion !== undefined) return r.nonPromotion.duelEligible;
  return r.outcome === "failure";                          // legacy/fake result: only a pipeline failure
}
```

`duelEligible` is **true only for `candidate-rejected`** — a real candidate ran the pipeline
(scout→builder→verifier→critic→integrator) and was judged not-promotable on quality/correctness
grounds (a role failed to converge, or the integrator/critic discarded a green candidate). It is
**false** for `governance-refused`, `unverifiable`, `injection-blocked`, `interrupted`, and
`candidate-conflict`.

**Assumption recorded (per the brief's "same-lane retry exhaustion, unless policy classifies it as
primary non-promotion"):** a primary lane that exhausts its in-lane retries without producing a
promotable candidate ends as `outcome === "failure"` → `candidate-rejected` → **duel-eligible**. This
is the documented duel intent ("one may fail but the other may be better"): the opposite vendor lane
is precisely the mitigation for a lane/provider-specific inability to converge. A pre-candidate hard
throw (provider outage) produces no result at all, so it can never become a peer duel (proven by a
test). Transient/parser/context recoveries are in-attempt and only reach the duel if they ultimately
yield a real `candidate-rejected`.

## Primary-attempt lifecycle

1. Rent → `AttemptModelDecision` (lane = `deepseek` for a duel primary); emit `worker.model_decision`.
2. Dispatch only lane-valid models (Phase 1 invariant preserved: rented == dispatched == billed ==
   receipt). Pre-flight context escalation may install a recorded same-lane replacement.
3. All escalation/retry/pool-sweep stay in-lane; all provider calls + cost recorded under the
   primary's (lane-distinct) task id.
4. Reach a terminal; classify `nonPromotion`. If promoted → **stop; no peer is created** (no peer
   provider call, workspace, rental, receipt, or cost).

## Peer-attempt lifecycle

Created **only** when `primaryWarrantsPeer(primary)` is true. It is a genuinely new attempt:

- New lane-distinct task id (`<id>:mimo`) and its own `AttemptModelDecision` (opposite lane).
- Its own workspace, provider calls, cost, and terminal outcome.
- It never rewrites the primary's receipts/identity and never claims to be a retry of the primary.
- If the peer promotes, its result is kept; otherwise the primary result stands (no false "best"
  claim — the two are not compared, only "keep the one that promoted", which is documented behavior).

## Retry vs peer distinction

- **Retry / escalation / pool sweep** = same attempt, same lane, recorded sub-decision, same task id.
- **Peer** = new attempt, opposite lane, new task id + decision + workspace.
  A retry can never silently become a peer: retries are lane-filtered (Phase 1 + this phase), and the
  peer is only ever launched by the CLI scheduler on a `candidate-rejected` primary.

## Operator fallback semantics (the chosen, documented rule)

`--fallback-model` in this codebase is an **escalation-only** hint (the initial dispatch never uses
it), i.e. it is always **post-dispatch**. The chosen semantic:

- **Same-lane fallback** → honored as a recorded **in-attempt** escalation pick (`laneFallbackModel`);
  the attempt's lane and initial decision are unchanged. (Not a fresh `orchestrator.run`; it is a
  recorded escalation sub-decision that stays in-lane — this is the codebase's existing, blessed
  in-attempt escalation mechanism, which "must not silently turn into a peer duel".)
- **Cross-lane fallback** → **not applied within the lane-pinned attempt** (it would silently mutate
  the attempt's lane identity). The in-lane ladder is used instead, and the operator's other-lane
  preference is realized by the **peer attempt** — a genuinely new attempt in that lane. So a
  cross-lane fallback "becomes a new attempt" exactly as required, without a bespoke redesign.
- **Unpinned attempt** (no duel) → every model is "in lane", so `--fallback-model` is honored
  verbatim, unchanged from before.

Implementation: `laneFallbackModel = fallbackModel iff (no lane) || fallbackModel.startsWith(lane)`.
It replaces `task.fallbackModel` at the critic-fix escalation `midModel` (which is **dispatched**),
the build-mode escalation `midModel` guard, and the pool-sweep `requestedModel`.

## Pre-flight escalation semantics

Unchanged from Phase 1 except it now also emits `worker.model_decision` with
`phase: "preflight-replacement"`. It remains: pre-dispatch only, same lane, bumps up to a
strictly-larger-window model, and it replaces the decision truthfully (no fictional execution is ever
recorded for the replaced model — the replaced model was never dispatched).

## Cost behavior before / after

- Before: a non-promoting primary of any class could spend a peer; primary and single-step peer
  shared one task id, so their costs were not separable.
- After: a peer is spent **only** on a `candidate-rejected` primary. Primary and peer have distinct
  task ids, so `ikbi cost`/run summaries attribute each attempt's spend separately. A promoted primary
  incurs **zero** peer cost (proven). No asynchronous/deferred peer work exists.

## Receipt behavior before / after

- Before: single-step primary and peer shared `requestId = task.taskId`; the attempt's model decision
  lived only on the builder role detail.
- After: each attempt has a distinct `requestId` (lane-suffixed task id) and, on the MoE/duel path,
  an explicit `worker.model_decision` receipt (`model`, `modelAlias`, `modelSource`, `vendorLane`,
  `attemptId`, `phase`) — written even for a pre-dispatch abort (records intent, never execution).
  Provider request model == `worker.model_decision` model == builder receipt model == the attempt's
  lane, all agree (proven).

## Files changed

- `src/modules/worker-model/contract.ts` — added `WorkerResult.nonPromotion` + the
  `NonPromotionClass` union.
- `src/modules/worker-model/orchestrator.ts` — set `nonPromotion` at every terminal; `laneFallbackModel`
  (lane-gate the operator fallback at the critic-fix `midModel`, build-mode `midModel`, and pool-sweep
  `requestedModel`); `worker.model_decision` receipt (initial + preflight-replacement), MoE-gated.
- `src/modules/worker-model/cli.ts` — pure `primaryWarrantsPeer` policy; narrowed the duel trigger to
  it; lane-distinct task id for single-step lane-pinned attempts; an explanatory "not dueling" line.
- `src/modules/worker-model/lane-duel-conformance.test.ts` — **new** (16 tests, three seams).

## Tests added (16, all green)

Pure policy (3): success→no-peer; only `candidate-rejected`→peer; legacy-result fallback.
CLI scheduler (7): promoted primary→one attempt, no peer cost; `candidate-rejected`→one peer,
distinct ids, cost sums both; governance-refused→no peer; unverifiable→no peer; infra throw→no peer;
both-fail→no promotion, two attempts, real cost; **negative** — peer not launched before the primary's
status is known.
Real orchestrator→provider seam (6): receipt conformance (provider request == `model_decision` receipt
== builder receipt == lane); **negative** cross-lane `--fallback-model` never dispatches out of lane;
same-lane fallback escalates in-lane; failing candidate → `candidate-rejected`/duel-eligible; gate-wall
denial → `governance-refused`/not-eligible; dirty-repo → `governance-refused`, no builder execution.

## Mutation / negative-test evidence

- Reverting the duel trigger to `outcome !== "success"` → scheduler tests **6 and 7 fail** (governance
  and unverifiable primaries would wrongly duel).
- Reverting the retry lane-filtering (recovery rosters + fallback `requestedModel`) → real-seam tests
  **12 and 13 fail** (a cross-lane `--fallback-model` leaks into an out-of-lane dispatch).
- The "peer not launched before promotion status known" guard (test 10) fails if the peer is spun
  before the primary result is inspected.

## Commands and exact results

```
pnpm build                                   # clean
# focused (15 files, new state root, dev keys, tokens unset):
#   lane-duel-conformance, model-identity-conformance, orchestrator, worker-model.cli,
#   expert-rental, tournament, competitive, production-wiring, production-defaults,
#   context-preflight, fixer-rescue, total-budget, interrupt-retain, drift-governor, router
pnpm test                                    # full suite
```

- `pnpm build`: **passed**.
- Focused suite: **274 / 274 passed**.
- New lane-duel suite alone: **16 / 16 passed** (and fails under the two mutations above).
- Phase 1 model-identity conformance (regression, req 13): **6 / 6 passed** (run inside the focused set).
- `pnpm test` (full): **tests 3503, pass 3502, fail 0, skipped 1**. Baseline after Phase 1 was
  3487/3486/0/1; the delta is exactly the +16 new tests. No pre-existing failures, none introduced.

## Commit

Single implementation commit, subject: `fix(orchestrator): enforce lane-pure conditional duel`
(the tip of `harness/cc-parity-and-bokahli-pilot` after this phase; resolve the SHA with
`git log -1 --format=%H`). Not pushed, tagged, or opened as a PR.

## Remaining cross-lane paths

- **Fixer / rescue model (IKBI-RT-012) — OPEN.** `config.fixerModel` (e.g. `mimo-v2.5-pro`) is a
  deliberately different model and is **not** lane-filtered, so within a lane-pinned attempt a fixer
  pass can run the other vendor's model. It never *misattributes* (it stamps the model it runs), but
  it is a real cross-lane exception. Left intact by design; **lane purity is therefore NOT globally
  fixed** — see below. This does not corrupt the primary/peer *attempt* records: the fixer is an
  internal rescue logged within the attempt, not a peer.
- **Tournament / competitive (IKBI-RT-004) — OPEN.** Own early-return funnels with their own candidate
  dispatch; not touched. They do not corrupt the primary/peer duel records (they are alternate modes,
  never the duel path).

## Status of IKBI-RT-002

**Fixed on the normal role / duel path.** The primary attempt is lane-pure (initial dispatch +
escalation + pool sweep + in-lane operator fallback), the peer is a genuinely separate attempt in the
opposite lane with its own id/decision/cost/receipts, and the duel is conditional on a truthful
`candidate-rejected` classification. **Not** claimed fixed globally: the fixer model (IKBI-RT-012) and
the tournament/competitive candidate paths (IKBI-RT-004) remain cross-lane exceptions.

## Answers to the required questions

- **Does IKBI-RT-012 remain open?** Yes — the cross-lane fixer model is unchanged and explicitly
  out of scope for this phase.
- **Can first-attempt promotion still incur peer cost?** No. The peer is created only inside the
  `primaryWarrantsPeer(result)` branch, which is false for `outcome === "success"`. There is no
  asynchronous or deferred peer work. Proven by the scheduler tests.
- **Is the Phase 1 invariant intact?** Yes — `rented == dispatched == billed == receipt` holds; the
  6 Phase 1 conformance tests remain green, and the receipt-conformance test re-verifies it on the
  duel path. Phase 2 only *added* classification/recording and *narrowed* the fallback to in-lane.
- **Is lane purity fixed globally or only on the normal role/duel path?** **Only on the normal role /
  duel path.** The fixer model (IKBI-RT-012) and tournament/competitive paths (IKBI-RT-004) remain
  documented cross-lane exceptions and are out of scope.

## Diff hygiene

The final diff touches only `contract.ts`, `orchestrator.ts`, `cli.ts`, and the new test file — all
on the lane-duel/attempt-identity path. No unrelated cleanup.
