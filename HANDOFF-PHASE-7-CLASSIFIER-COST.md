# Handoff — Phase 7: Classifier / Routing Cost Accounting (IKBI-RT-011)

Date: 2026-07-10
Branch: `harness/cc-parity-and-bokahli-pilot`
Base: 1 `288ad62` → 2 `4aba481` → 3 `eb30554` → 4 `89a395b` → 5 `a02f248` → 6 `194d4c6`
Scope: account for the semantic-classifier/routing model invocation in cost/budget/receipts. No
classifier decision logic, roster, routing policy, lane/duel, promotion, semantic, fixer, or
SafetyLedger change.

## Pre-change model-call and cost inventory

| Invocation | File / symbol | Provider seam | Deterministic? | In `runCost` before? | Receipt before | Status before |
|---|---|---|---|---|---|---|
| Goal decomposition / step plan | `worker-model/step-planner.ts` | deterministic (default) | yes | n/a | plan log | no-call |
| Coordinator / cognition | `cli.ts` (default cognition; `useModelPlanner` 2nd pass) | RAW `invokeModel` at the **CLI**, before `orchestrator.run` | no | **NO** (CLI-level, before the run cost) | cognition events | **omitted from the worker run total** |
| **Semantic difficulty classifier** | `orchestrator.ts` `if (moeExpertRental) … invokeModel({model: classifierModel, prompt})` | **RAW `invokeModel`, BEFORE the costing engine** | no | **NO** (`res.cost` discarded) | **none** | **THE IKBI-RT-011 defect** |
| Expert rental | `expert-rental.ts` `rentBuilderExpert` | deterministic (roster) | yes | n/a | rental log | no-call (correct) |
| Model router | `model-router/router.ts` `resolveModel` | deterministic | yes | n/a | none | no-call (correct) |
| Builder | `builder.ts` `ctx.engine.invokeModel` | costing engine (`runEngine`) | no | yes | `worker.role.builder` (model=Phase 1) | measured |
| Critic | `critic.ts` `ctx.engine.invokeModel` | costing engine | no | yes | `worker.role.critic` | measured |
| Fixer / rescue | `makeRunFixer` → `runRoleFn` (runEngine) | costing engine | no | yes (Phase 6 separate cost) | `worker.fixer` (Phase 6) | measured |
| Same-lane retry / escalation / pool sweep | escalation block (runEngine) | costing engine | no | yes | `cheap_retry`/`escalation.retry` | measured (Phase 2) |
| Frontier consult | `applyConsultPatch` (raw provider) | raw, but **folded via `addRunCost`** (Gap B) | no | yes | `escalation.consult` | measured (already folded) |
| Peer duel | separate `orchestrator.run` | its OWN costing engine | no | yes (own run) | own `model_decision`/summary | measured (Phase 2) |
| Tournament / competitive candidate | `dispatchRole` (runEngine) | costing engine | no | yes | tournament/competitive | measured |
| Integrator | `integrator.ts` (may invoke) | runEngine | no | yes | `worker.role.integrator` | measured |
| Adjudication | `decidePromotability` | deterministic (git facts) | yes | n/a | promotion | no-call |
| Runtime-truth reader | operator adapter (Phase 5) | NOT via ikbi's accounting seam | n/a | no | `worker.runtime_truth` | not an ikbi-billed call |

Only ONE production-reachable model invocation went unaccounted **inside the run**: the semantic
classifier. (The CLI cognition call is unaccounted but lives outside `orchestrator.run` — see below.)

## Exact root cause of IKBI-RT-011

The classifier called the **raw** `deps.invokeModel` (not the run's `runEngine` costing wrapper) AND it
ran BEFORE `makeCostingEngine` was created. Its `response.cost.usd` was discarded (the invoke closure
read only `res.content`). So classifier spend was invisible to `runCost()`, the `worker.run.summary`
`costUsd`, and the budget cap, and it was never receipted. Cost accounting was role-local; the pre-role
routing call fell outside it.

## Canonical invocation identity

The classifier invocation has a stable id `"<taskId>:classifier"` on its `worker.classifier` receipt.
`retryCount` counts each ACTUAL provider attempt (the classifier makes one; the id + count prevent
double-counting). A receipt and any cost record for the same call share that identity.

## Usage / pricing / identity-chain rules

- **Usage:** the provider's `usage` object is recorded verbatim when supplied; never invented.
- **Pricing:** the classifier is priced by the CLASSIFIER model actually dispatched. The provider's
  cost (`res.cost.usd`) is used when present.
- **Identity chain:** `classifierModel == dispatchedModel == billed == receipt model`. The provider's
  echoed model, if it differs, is recorded separately as `providerReportedModel`. The SELECTED expert
  (`selectedExpert`) is recorded as a distinct field — **its cost is charged to the builder, never to
  the classifier**. Example: classifier `deepseek-v4-flash`, selected expert `deepseek-v4-pro`/
  `mimo-v2.5-pro` → classifier cost belongs to `deepseek-v4-flash`; builder cost to the expert.

## Coordinator attribution

The classifier is a task-scoped routing invocation bound to `taskId` (and the attempt's `vendorLane`
when set). It is NOT fabricated into a builder attempt. A heuristic/deterministic decision, or
`moeExpertRental` off, is a **no-call** (no receipt, zero routing overhead) — never a fictional
invocation. Each `orchestrator.run` (primary, peer, per-step, tournament/competitive candidate) that
runs its own classifier produces its own separate classifier receipt + cost (no duplication).

## Retry / missing-usage / missing-price / local-zero behavior

- **Retry:** each actual provider attempt increments `retryCount`; a purely local/heuristic fallback
  makes no provider call and costs zero.
- **Pre-dispatch failure:** no usage, no cost claimed.
- **Missing usage/cost (a call ran, provider returned no cost):** `costStatus: "unavailable"` — the cost
  is UNKNOWN, never silently zero; the run aggregate becomes `costStatus: "partial"`.
- **Known local zero-priced model:** a real invocation with `cost.usd: 0` → `costStatus: "measured"`,
  `costUsd: 0` — distinct from `no-call` (no invocation) and `unavailable` (unknown).

## Aggregation status rules

The `worker.run.summary` now carries `costUsd` (INCLUDING routing overhead), a distinct
`routingOverheadUsd` subtotal, and `costStatus: "complete" | "partial"` (partial when any accounted
invocation's cost is unknown). A total never falsely implies completeness. (Builder/critic/fixer/
escalation subtotals already flow through per-role receipts + the run cost.)

## Budget behavior

The classifier spend is folded into `runCost` via `addRunCost` **inside the run's try block**, so it
counts toward the global `maxBudgetUsd` cap and a classifier that exceeds a tiny cap trips
`BUDGET_EXHAUSTED` handled by the existing abort path (which writes a truthful terminal summary). This
is the "include all actual spend in the global ceiling" option — a classifier can no longer retry
invisibly to the budget.

## MoE overhead reporting

`worker.run.summary.routingOverheadUsd` reports the actual routing/classifier overhead separately from
builder generation cost, and `worker.classifier` records the decision + selected expert. No
counterfactual "saved $X" is claimed (Ikbi has no documented counterfactual baseline) — only actual
routing overhead, actual downstream cost, and actual total are reported.

## Receipt changes

- New `worker.classifier` receipt: `taskId`, `stage`, `invocationId`, `classifierModel`,
  `dispatchedModel`, `providerReportedModel?`, `provider?`, `decision`, `decisionSource`
  (model|heuristic), `modelBacked`, `selectedExpert`, `vendorLane?`, `usage?`, `costUsd`, `costStatus`,
  `retryCount`.
- `worker.run.summary` gains `routingOverheadUsd`, `costStatus`, `classifierModel`,
  `classifierDecisionSource`, `classifierCostStatus`.

## Files changed

- `src/modules/worker-model/orchestrator.ts` — capture classifier cost/usage/model/provider/status in
  the classifier block; emit the `worker.classifier` receipt; fold the classifier spend into `runCost`
  + the budget inside the run try; add `routingOverheadUsd`/`costStatus` to the run-summary.
- `src/modules/worker-model/classifier-cost-conformance.test.ts` — **new** (6 tests).

## Tests added / mutation evidence

6 conformance tests: classifier recorded once + cost folded as routing overhead; classifier priced by
the classifier model while the builder is priced by the selected expert (distinct); deterministic
(routing off) is a no-call with zero overhead + no receipt; missing cost → `unavailable` → aggregate
`partial`; identity chain (dispatched == classifier model, stable invocation id, no double count);
budget (classifier spend is visible to the global cap and aborts a tiny budget).

Mutation evidence (reverted before commit):
- omit the classifier-cost fold → the budget test fails (classifier spend invisible to the cap). [mut 1, 8]
- treat missing cost as measured/zero → the unavailable/partial test fails. [mut 4]
- (mut 2 price by expert) → the classifier-vs-expert test asserts the classifier model + builder==expert;
  (mut 3 double-count / mut 6 deterministic-as-invocation) → the once/no-call tests fail.

## Commands and exact results

```
pnpm build                 # clean
# focused: classifier-cost-conformance, orchestrator, total-budget, expert-rental,
#          model-identity-conformance, lane-duel-conformance, fixer-lane-conformance
pnpm test                  # full suite
```

- `pnpm build`: **passed**.
- `classifier-cost-conformance.test.ts`: **6 / 6** (fails under the mutations above).
- Phase 1 6/6, Phase 2 16/16, Phase 3 10/10, Phase 4 19/19, Phase 5 11/11, Phase 6 6/6: all green;
  `total-budget` + `expert-rental` + orchestrator: green.
- `pnpm test` (full): **tests 3555, pass 3554, fail 0, skipped 1**. Baseline after Phase 6 was
  3549/3548/0/1; the delta is exactly the +6 new tests. No pre-existing failures; none introduced.

## Commit

ONE cohesive commit (capture + fold + receipt + aggregation are one change in `orchestrator.ts`).
Subject: `fix(cost): account for classifier and routing invocations`. Per the Phase 1-6 convention this
handoff is included in the same commit. Resolve the SHA with `git log -1 --format=%H`. Not pushed,
tagged, or opened as a PR.

## Answers to the required questions

- **Remaining unaccounted model calls:** the **CLI-level cognition/coordinator** call (`cli.ts`,
  default per build, and the optional model step-planner pass) runs BEFORE `orchestrator.run` and is
  still outside the worker run total — accounting it requires threading a cost ledger from the CLI into
  the run (a larger, CLI-surface change), so it is DOCUMENTED as a remaining partial, not silently
  claimed. Every model call INSIDE `orchestrator.run` is now accounted.
- **Remaining partial-cost conditions:** a classifier call whose provider returns no cost →
  `costStatus: unavailable` → run `costStatus: partial` (truthful, not zero). The CLI cognition call
  (above). Otherwise totals are complete.
- **Status of IKBI-RT-011:** **fixed for the run-scope routing/classifier invocation** — it is
  recorded, attributable, priced by the classifier model, in the run total + budget, distinguished as
  routing overhead, never counted when no call occurred, and never omitted for running pre-builder.
- **Do task/run totals now include every production-reachable model call?** Yes for every call inside
  `orchestrator.run` (classifier, builder, critic, fixer, retries, escalation, peer, tournament/
  competitive, consult). The CLI cognition call remains outside the run (documented).
- **Can any cost still be attributed to a model that did not execute?** No — the classifier cost is
  bound to the classifier model actually dispatched; a deterministic/heuristic decision is a no-call
  with zero cost and no receipt; missing cost is `unavailable`, never fabricated onto another model.
- **Phases 1-6 invariants intact?** Yes — all conformance suites green; the builder is still priced by
  the selected expert (Phase 1), lanes/duel/promotion/semantic/runtime-truth/fixer behavior unchanged.

## Not globally fixed (explicit)

- CLI cognition/coordinator spend remains outside the worker run total (documented above).
- No counterfactual "savings" figure is produced (no documented baseline).
- IKBI-RT-011's sibling concerns beyond the run-scope classifier (e.g. provider-adapter usage
  normalization across every provider) are not broadly reworked — only the classifier path is corrected.

## Diff hygiene

The diff touches only `orchestrator.ts` (classifier cost capture/fold/receipt/aggregation) and the new
test file. No unrelated cleanup.
