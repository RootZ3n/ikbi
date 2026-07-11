# Handoff — Phase 6: Truthful, Lane-Pure Fixer/Rescue (IKBI-RT-012)

Date: 2026-07-10
Branch: `harness/cc-parity-and-bokahli-pilot`
Base: Phase 1 `288ad62` → 2 `4aba481` → 3 `eb30554` → 4 `89a395b` → 5 `a02f248`
Scope: make fixer/rescue execution truthful about attempt, lane, model, candidate, defects, cost, and
receipts. No router/roster/promotion-caller/trust/critic-prompt/SafetyLedger redesign; no cross-lane
child-attempt machinery (cross-lane repair is owned by the existing Phase 2 peer).

## Pre-change repair-path inventory

| Path | Entrypoint | Trigger | Orig attempt/lane | Fixer model source | Fixer lane (before) | Workspace | Re-verify | Semantic re-eval | Cost (before) | Receipt (before) | Cross-lane visible? | Reachable |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Fixer-on-verifier-fail | orchestrator `if (role==="verifier" && isFixableVerifierFailure)` | concrete deterministic verifier RED (typecheck/tests fail) | `task.taskId` / `modelDecision.vendorLane` | `config.fixerModel` | **cross-lane possible** | current (in-place) | yes | yes (critic after) | folded into builder role | none (log only) | **no** | yes (fixer configured) |
| Builder-stop rescue | `maybeAutoVerifyRescueBuilderResult` (`makeRunFixer`) | protocol-stopped builder w/ work + RED rescue verify | same | `config.fixerModel` | **cross-lane possible** | current | yes | yes | folded | none (stamp only) | **no** | yes |
| Terminal adjudication rescue | orchestrator terminal, `maybeAutoVerifyRescueBuilderResult(makeRunFixer)` | any builder failure w/ work on a verifiable target | same | `config.fixerModel` | **cross-lane possible** | current | yes | yes | folded | none | **no** | yes |
| Critic-fix loop | `runCriticFixLoop` (`config.criticFixLoop`, opt-in) | `isRetryableCriticFail` (pass:false) | same | builder / escalation mid | in-lane (Phase 2) | current | yes | yes | run-cost | fix_loop receipt | in-lane | opt-in |
| Critic-fix escalation | orchestrator critic block (Phase 4) | `isRetryableCriticFail` | same | `laneFallbackModel ?? laneModelsFor(mid)[0]` | in-lane (Phase 2) | current | yes | yes | escalation receipt | escalation.retry | in-lane | yes |
| Cheap same-model retry | escalation block (Phase 2) | builder failure/stall | same | `failedModel` (same) | in-lane | current | via pipeline | yes | cheap_retry receipt | cheap_retry | in-lane | yes |
| Model escalation / pool sweep | escalation block (Phase 2) | builder failure | same | `laneModelsFor(...)` rosters | in-lane (Phase 2) | current | yes | yes | escalation receipt | escalation.retry | in-lane | yes |
| Tournament / competitive candidate | `dispatchRole` candidate loop | per-candidate | task / n/a | candidate model | own | yes (shadow reverify) | Phase 4 winner critic | run-cost | tournament/competitive | n/a | flag |
| Duel primary / peer | cli scheduler | Phase 2 duel eligibility | distinct lane-suffixed ids | rental | in-lane (Phase 2) | own workspace | yes | yes | separate attempt | model_decision + role | yes | `--tier cheap` |
| Adjudication / legacy / experimental | terminal (Phase 3) | promote decision | same | n/a (no model) | n/a | current | n/a | n/a | n/a | promotion | n/a | default / flag |

The ONLY cross-lane-capable repair was the shared `config.fixerModel` fixer (rows 1-3). Every other
repair/retry path was already in-lane (Phase 2) or model-less.

## Exact root cause of IKBI-RT-012

`makeRunFixer` dispatched `config.fixerModel` (e.g. `mimo-v2.5-pro`) via
`builderForModel(parentCtx, config.fixerModel, …)` **with no lane filter** — so a DeepSeek-lane attempt
could silently run a MiMo model *inside* that attempt. The fixer also ran off-books: no receipt, its
cost folded into the builder role, so its model/lane/cost were not truthfully recorded and a cross-lane
crossing was invisible.

## Chosen repair/duel policy

**Same-lane fixer (policy 1) + peer-owns-cross-lane (policy 3).** The fixer runs SAME-LANE: `config.fixerModel`
is honored only when it is in the attempt's vendor lane; a cross-lane fixer model is replaced by the
lane's strongest in-lane model (`laneModelsFor(mid)[0]`). Cross-lane repair is NOT a hidden substitution
and NOT a bespoke cross-lane child attempt — because only TWO vendor lanes exist, the OTHER vendor's
repair is already provided by the **Phase 2 peer attempt**; creating a separate cross-lane child would
duplicate and pay for it twice. For an UNPINNED attempt (normal build, no duel) `config.fixerModel` is
honored verbatim (no lane to violate). This is the brief's recommended default; it introduces no third
hidden execution category (the `worker.fixer` receipt distinguishes every repair truthfully).

### Duel interaction (exact rule)

- The primary candidate may receive **bounded same-lane** repair (≤ `MAX_FIXER_ROUNDS`) inside its lane.
- If it still ends in a concrete, duel-eligible candidate rejection, the Phase 2 scheduler launches the
  peer attempt in the OTHER lane (unchanged). Repair happens **before** duel eligibility is finalized;
  a failed same-lane repair leaves the candidate rejection that the duel policy then evaluates.
- A cross-lane fixer is **never** silently used before the peer; the peer lane IS the cross-lane repair.
- The peer candidate may itself receive bounded same-lane repair **in the peer lane** (its own
  `modelDecision.vendorLane`), and can never cross back into the primary lane.
- No third vendor-lane attempt exists; the peer mechanism is not paid twice.

## Definitions

- **Same-attempt repair:** stays in the current attempt's vendor lane; the dispatched model is recorded
  truthfully; the repair's cost + receipt belong to the attempt; the repaired output is a NEW candidate
  revision (new tree); all prior verification/semantic evidence is stale for promoting the new tree.
- **Cross-lane repair:** any model outside the attempt's lane — here it is **not** executed inside the
  attempt; the in-lane model is used, and the operator's other-lane preference is realized by the peer.
- **Repair attempt:** in this architecture, the peer attempt (a distinct lane-suffixed task id +
  `AttemptModelDecision` + workspace + cost + receipts) is the cross-lane repair vehicle.
- **Retry:** a same-lane repeat (cheap same-model retry, pool sweep) that never crosses lanes.

## Operator `--fallback-model`

Unchanged from Phase 2 and consistent here: honored as an in-lane escalation pick only
(`laneFallbackModel`); a cross-lane `--fallback-model` is deferred to the peer attempt. The fixer's
lane gate applies the same discipline to `config.fixerModel`.

## Repair budget

`MAX_FIXER_ROUNDS = 2` per run (hard cap on fixer model passes), plus a `treeUnchanged` guard recorded
on the receipt. The loop stops when: the candidate promotes, the budget is exhausted, no concrete
repairable defect exists, the repaired tree is unchanged, the same failure persists, infrastructure
fails, or governance blocks. The fixer never silently escalates into tournament/peer behavior.

## Candidate provenance model (`worker.fixer` receipt)

`sourceTaskId`, `sourceAttemptId`, `sourceCandidateTree`, `repairAttemptId`, `repairRound`,
`repairStrategy` ("same-lane"), `fixerTrigger`, `failingChecks`, `fixerModel` (selected == dispatched),
`dispatchedModel`, `vendorLane`, `crossLaneAvoided`, `resultingCandidateTree`, `treeUnchanged`,
`verificationOutcome`, `costUsd`, `promoted:false`. The source tree and the resulting tree are distinct;
the source verdicts are stale for the repaired tree.

## Old vs new

- **Dispatch:** before → `builderForModel(config.fixerModel)` (cross-lane possible). after →
  `builderForModel(laneFixerModel)` (in-lane; cross-lane config replaced by the in-lane pro).
- **Cost:** before → folded into the builder role. after → captured as a separate `costUsd` on the
  `worker.fixer` receipt (billed to the dispatched fixer model).
- **Receipts:** before → none (a log line + a `fixerModel` stamp on the builder detail). after → a
  durable `worker.fixer` receipt with the full provenance chain; the builder-detail stamp now reflects
  the LANE-VALID dispatched model, not the raw config.
- **Trigger:** before → `isRetryableCriticFail` = `pass:false && !objectiveFailure` (a bare/indeterminate
  critic FAIL could fire the critic-fix loop). after → also requires a CONCRETE semantic verdict
  (`fail`/`incomplete`); `indeterminate`/`infrastructure-failure` never trigger repair. (The
  deterministic fixer's `isFixableVerifierFailure` trigger was already concrete and is unchanged.)

## Deterministic re-verification + semantic re-evaluation

Unchanged pipeline ordering already guarantees fresh evaluation of the repaired tree: the fixer
re-verifies (`runRescueVerifier`) on the repaired worktree; the critic runs AFTER the verifier on that
repaired tree; and Phase 3 captures `verifiedTree = readTreeHash` AFTER all roles/rescue, so promotion
binds the REPAIRED tree (and the authority's stale-tree check blocks any post-repair mutation). The
`worker.fixer` receipt records `sourceCandidateTree` vs `resultingCandidateTree` so the source evidence
is explicitly stale. Source verification/semantic pass/fail is never reused for the repaired tree.

## Runtime-truth scoping

The same-attempt fixer requests Phase-5 evidence scoped to `{taskId, attemptId=taskId, candidateId=taskId,
strategy:"fixer:<trigger>"}` — its own attempt/candidate scope; the Phase-5 filter omits any cross-task/
repo/candidate/stale item, so no primary/peer/repair evidence leaks. Runtime truth is advisory; a reader
failure yields no evidence and never creates a repair trigger.

## Files changed

- `src/modules/worker-model/orchestrator.ts` — `laneFixerModel` (lane-gate `config.fixerModel`);
  `makeRunFixer` now dispatches the lane-valid model, requests scoped runtime evidence, captures separate
  cost, enforces `MAX_FIXER_ROUNDS`, and emits a truthful `worker.fixer` receipt returning the dispatched
  model; the builder-stop + verifier-fail stamps use the dispatched model.
- `src/modules/worker-model/critic-fix-loop.ts` — `isRetryableCriticFail` gates on a concrete semantic
  verdict (fail/incomplete), with a legacy fallback.
- `src/modules/worker-model/fixer-lane-conformance.test.ts` — **new** (6 tests).

## Tests added / mutation evidence

6 conformance tests: cross-lane MiMo config in a DeepSeek attempt is replaced by the in-lane model
(crossLaneAvoided); in-lane config honored verbatim; unpinned honored verbatim; provenance + cost
recorded; trigger discipline (concrete fail/incomplete retryable; indeterminate/infra/objective NOT;
legacy fallback); and a REAL-dispatch test proving the fixer's provider request carries exactly the
receipt's lane-valid model and no MiMo model ever runs inside the DeepSeek attempt.

Mutation evidence (reverted before commit):
- fixer dispatches `config.fixerModel` verbatim (silent cross-lane) → cross-lane + real-dispatch tests
  fail (MiMo runs inside the DeepSeek attempt). [mut 1, 6 — the peer/primary-lane crossing]
- remove the semantic trigger gate → the trigger test fails (indeterminate becomes retryable). [mut 4]
- (mut 3 source-verification reuse) → Phase 3's `promotion-funnel` stale-tree tests already fail when
  the repaired-tree binding is broken; (mut 8 evidence leak) → Phase 5's filter tests fail.

## Commands and exact results

```
pnpm build                 # clean
# focused: fixer-lane-conformance, fixer-rescue, critic-fix-loop, orchestrator, lane-duel,
#          promotion-funnel, semantic-contract, runtime-truth-conformance, competitive, tournament
pnpm test                  # full suite
```

- `pnpm build`: **passed**.
- `fixer-lane-conformance.test.ts`: **6 / 6** (fails under the mutations above).
- Phase 1 6/6, Phase 2 16/16, Phase 3 10/10, Phase 4 19/19, Phase 5 11/11: all green; existing
  `fixer-rescue` + `critic-fix-loop` + orchestrator/competitive/tournament: green.
- `pnpm test` (full): **tests 3549, pass 3548, fail 0, skipped 1**. Baseline after Phase 5 was
  3543/3542/0/1; the delta is exactly the +6 new tests. No pre-existing failures; none introduced.

## Commit

ONE cohesive commit (the lane gate, the receipt, and the trigger gate are interdependent; the
orchestrator.ts hunks cannot be cleanly split without interactive staging). Subject:
`fix(rescue): make fixer execution lane-pure, attempt-truthful, and receipted`. Per the Phase 1-5
convention this handoff is included in the same commit. Resolve the SHA with `git log -1 --format=%H`.
Not pushed, tagged, or opened as a PR.

## Answers to the required questions

- **Remaining cross-lane execution paths:** none on the fixer/repair path — the fixer is now lane-pure;
  cross-lane repair is the Phase 2 peer attempt (a distinct, separately-receipted attempt, not a hidden
  substitution). Tournament/competitive candidates never ran the `config.fixerModel` fixer.
- **Remaining repair bypasses:** none produce an unreceipted or cross-lane fixer. The critic-fix loop
  (opt-in) and escalation were already in-lane (Phase 2) and now also trigger-gated on concrete verdicts.
- **Status of IKBI-RT-012:** **fixed** — fixer/rescue is lane-pure, truthfully receipted (selected ==
  dispatched == billed == receipt), separately cost-attributed, bounded, provenance-bearing, and
  concrete-defect-triggered.
- **Is lane purity now global across normal, duel, and fixer paths?** **Yes** for model dispatch: the
  normal/duel escalation ladder (Phase 2), the operator fallback (Phase 2), and now the fixer (Phase 6)
  are all lane-pure; cross-lane work only ever happens as the explicit peer attempt.
- **Can any fixer still execute under an incorrect attempt identity?** No — the fixer runs inside its
  source attempt, in that attempt's lane, and its receipt records the source attempt/candidate/tree; it
  never mutates another attempt's identity or receipts.
- **Can any repaired candidate reuse source-candidate evidence?** No — the repaired tree is re-verified +
  re-critiqued, promotion binds the repaired `verifiedTree` (Phase 3), and the receipt marks the source
  tree distinct from the resulting tree.
- **Phases 1-5 invariants intact?** Yes — all conformance suites green; the fixer now satisfies Phase 1
  (dispatched==billed==receipt) for its own model, Phase 2 (lane purity), Phase 3 (repaired tree ==
  promoted tree, sole promote authority), Phase 4 (concrete-defect trigger), Phase 5 (scoped evidence).

## Not globally fixed (explicit)

- The cross-lane repair *capability* is intentionally realized only via the Phase 2 peer (two lanes);
  there is no independent cross-lane child-attempt mechanism (by design — it would double-pay the peer).
- IKBI-RT-011 (classifier cost accounting) and the synthesized SafetyLedger remain out of scope and
  unchanged.

## Diff hygiene

The diff touches only `orchestrator.ts` (fixer lane/receipt/cost/budget/runtime-truth), `critic-fix-loop.ts`
(trigger gate), and the new test file — all on the fixer/repair path. No unrelated cleanup.
