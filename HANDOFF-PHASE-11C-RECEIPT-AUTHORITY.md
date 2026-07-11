# HANDOFF — Phase 11C: Receipt Authority (execution receipts bind to the invocation ledger)

## The invariant this phase closes

> Every receipt that CLAIMS a provider/model executed must reference the authoritative invocation
> record describing that execution, and must DERIVE its execution identity — invocation id, served
> model, provider, vendor lane, lifecycle, usage, cost, cost status — from that ledger record. No
> execution receipt may independently invent or restamp any of those, fall back to a configured/selected
> model when the ledger says otherwise (or nothing) ran, or silently omit the linkage. A missing
> invocation is FAIL-CLOSED: an explicit integrity-error receipt, never a fabricated id or config fallback.

Phase 11 built the ledger and made cost/summary derive from it; Phase 11B made the ledger the *execution
authority* (lane enforcement, role receipts referencing invocations). Phase 11C closes the three seams
those left where a receipt could still speak about execution without pointing at the record that proves it:
**critic recovery**, the **fixer**, and the **tournament/competitive per-role + aggregate** receipts.

## Verified starting state

- HEAD at start: `af7e71f` (217 ahead of `origin/main`, unpushed). Tracked tree clean.
- Pre-existing untracked files (`.claude/`, `IKBI-RUNTIME-CONFORMANCE-AUDIT.md`, `ikbi-0.1.0-rc.1.tgz`,
  `scripts/ui-verify/package-lock.json`) were left untouched.
- `makeCostingEngine` already returned `{ engine, cost, ledger }` (Phase 11). `recordRole` already accepted
  an optional `invocationId` and wrote it into the role receipt (Phase 11B). Phase 11C builds on both.

## Full execution-receipt inventory (worker-model orchestrator)

**Execution receipts — CLAIM a model ran; each now references its authoritative invocation record:**

| Receipt | Linkage | Notes |
|---|---|---|
| `worker.role.builder` / `.critic` / `.verifier` / `.scout` / `.integrator` | `invocationId` + dispatched model (`requestedAlias`) from `lastFor(role[,stage])` | Phase 11B main loop; Phase 11C wired the competitive/tournament path via `dispatchRole(…, runLedger)` and pinned the critic role receipt to its **primary** `role`-stage invocation (not the nested recovery). |
| `worker.critic_recovery` | `invocationId` + served model / provider / lane / lifecycle / usage / cost / cost-status from `lastFor("critic","structured-recovery")` | **New in 11C.** Emitted only when recovery actually ran; missing record ⇒ `worker.critic_recovery.integrity_error`. |
| `worker.fixer` | `invocationId` + `invocationIds[]` + served model / provider / ledger cost-status from the `fixer`-staged records; `executionLinked` flag | **New in 11C.** `fixerModel`/`dispatchedModel` remain the SELECTED lane model (Phase 6 "selected==dispatched==receipt"); the SERVED model + linkage derive from the ledger. `executionLinked:false` when no provider call was dispatched (e.g. an injected no-op builder) — a truthful "no execution", not an error. |
| `worker.classifier` | routing invocation recorded via `recordExternal`; receipt carries its invocation id | Pre-existing; lane-neutral pre-attempt call. |
| `worker.role.builder` (re-recorded on escalation / cheap-retry) | `runLedger.lastFor("builder")?.invocationId` | Pre-existing (Phase 11B); the escalated/retry builder's execution truth lives here. |

**Aggregate receipts — SUMMARIZE many invocations; now reference every executed invocation once:**

| Receipt | Linkage | Notes |
|---|---|---|
| `worker.run.summary` | `invocationIds` (ordered, de-duplicated `executedIds()`) + `primaryInvocationId` (last builder) + `invocationCount` + `costStatus` | **New in 11C:** `invocationIds` + `primaryInvocationId`. Aggregate cost/model/status already derived from the ledger (Phase 11). |
| `worker.tournament` | `invocationIds` + `invocationCount` + `costStatus` from the shared run ledger | **New in 11C.** A tournament receipt is a SELECTION over all candidates; it references every candidate/evaluator/critic/recovery invocation once and never stamps one candidate's or the winner's model as if it executed the whole tournament. |

**Transition / selection / promotion / evidence receipts — NOT independent execution claims (no change needed):**

- `worker.escalation.retry`, `worker.cheap_retry` — transition receipts (`fromModel`→`toModel` are the
  SELECTED endpoints of an escalation decision). The escalated builder's EXECUTION is authoritatively
  receipted by the re-recorded `worker.role.builder` (ledger-linked). Not a fresh execution claim.
- `worker.escalation.consult` — the frontier consult; recorded through the ledger's `recordExternal`.
- `worker.semantic` — durable evidence keyed by `semanticEvaluationId`; the evaluator's execution is
  authoritatively bound by `worker.role.critic` (+ `worker.critic_recovery`). Not an independent claim.
- `worker.promotion` — a PROMOTION receipt; its `model` is the promoted candidate's builder model, which
  derives from the ledger-linked `worker.role.builder`; it references `semanticEvaluationId` + `verifiedTree`.
- `worker.model_decision` — a deterministic SELECTION receipt (the decided model); model-free of execution.
- `worker.build`, `worker.runtime_truth`, `worker.safety_assessment`, `worker.checks_unresolvable`,
  `worker.greenfield_scaffold`, `worker.lane_config_error`, `worker.run.drift_blocked`,
  `worker.promotion.*` (withheld/stale/tree-identity), `worker.trust.*`, `worker.adjudication.*`,
  `worker.decision.divergence`, `worker.critic_fix_loop[.skipped]` — governance/evidence/decision receipts,
  no independent execution identity to bind.

## Receipts that previously lacked invocation linkage (and how 11C fixed them)

1. **`worker.critic_recovery`** previously stamped `invocationId`/`recoveryModel` from the critic result's
   own `detail.recoveryInvocationId`/`recoveryModel` (a critic-authored synthetic id + a selected model).
   Now it references `lastFor("critic","structured-recovery")` and derives every execution field from that
   record; a claimed-but-unbacked recovery becomes `worker.critic_recovery.integrity_error`.
2. **`worker.fixer`** previously stamped only `fixerModel`/`dispatchedModel` (the SELECTED model), with no
   link to the record proving a provider call ran. Now it also carries `executionLinked`, `invocationId`,
   `invocationIds[]`, `servedModel`, `provider`, and `ledgerCostStatus` derived from the `fixer`-staged
   records.
3. **Tournament/competitive per-role receipts** previously stamped `result.detail.model` (or nothing) with
   no invocation id. Now `dispatchRole` tags each candidate role's provider calls in the ledger (stage
   `candidate-role`) and derives the receipt's model + `invocationId` from that record.
4. **`worker.run.summary`** and **`worker.tournament`** carried aggregate cost/count but no id set. Both now
   carry `invocationIds` (unique, ordered) so an auditor can enumerate every request the aggregate covers.

## Changes made

### `contract.ts`
- `RoleEngine.invokeModel` gains an optional `meta?: { stage?; retryKind? }` so a role can tag a DISTINCT
  sub-invocation (the critic's structured-output recovery) under its own ledger stage.

### `critic.ts`
- The recovery dispatch now passes `{ stage: "structured-recovery", retryKind: "structured-recovery" }`, so
  the recovery becomes a distinct ledger record the receipt can reference.

### `invocation-ledger.ts`
- `engine.invokeModel` threads `meta` → `invoke` as a context override.
- `lastFor(role, stage?)` gains an optional `stage` filter and skips non-executed records.
- New `executedIds()`: ordered, de-duplicated invocation ids of every EXECUTED record (excludes
  pre-dispatch `lane-blocked`) — the aggregate linkage a summary/strategy receipt uses.

### `orchestrator.ts`
- `emitSemanticEvidence(…, ledger?)`: the `worker.critic_recovery` receipt derives all execution fields
  from `lastFor("critic","structured-recovery")`; missing record ⇒ `worker.critic_recovery.integrity_error`.
  All three call sites (normal / competitive / tournament) pass `runLedger`.
- Fixer dispatch wrapped in `runLedger.withContext({ stage:"fixer", … })`; the `worker.fixer` receipt derives
  `executionLinked` / `invocationId` / `invocationIds` / `servedModel` / `provider` / `ledgerCostStatus` from
  the `fixer`-staged records (selected model unchanged).
- Main-loop critic role receipt pinned to `lastFor("critic","role")` so it does not alias the nested recovery.
- `dispatchRole(…, ledger?)`: wraps the candidate role dispatch in `ledger.withContext({ stage:"candidate-role", … })`
  and derives the receipt's model + `invocationId` from `lastFor(role,"candidate-role")`. All 11 competitive/
  tournament call sites now pass `runLedger`.
- `worker.run.summary`: added `invocationIds` (`executedIds()`) + `primaryInvocationId` (last builder).
- `worker.tournament`: added `invocationIds` + `invocationCount` + `costStatus`.

## Tests

New file: `src/modules/worker-model/phase11c-receipt-authority-conformance.test.ts` — **18 tests, all green.**

- **A1–A4** recovery: references the actual structured-recovery invocation; model/provider/lane/lifecycle/cost
  DERIVE from it; recovery-not-dispatched ⇒ no receipt; missing invocation ⇒ integrity-error (never fabricated
  id / config fallback).
- **B1–B3** fixer: references the fixer-staged invocation(s); served model + cost-status from the ledger while
  the dispatched field stays the selected lane model; a cross-lane `config.fixerModel` never becomes the
  served/executed model.
- **C1–C3** tournament: every candidate builder references its OWN invocation with its OWN model; the aggregate
  `worker.tournament` references every executed invocation once (no double-count, count-consistent); no single
  model stamped on all.
- **D1–D3** competitive: every candidate builder references its own invocation; the winner's identity does not
  overwrite the loser's role receipt; per-role invocation ids are distinct.
- **E1–E2** run.summary: aggregates every executed invocation once + names a primary; a role receipt's linked
  id is a genuine member of the aggregate set.
- **F1–F3** ledger guards: `executedIds()` de-duplicates + preserves order (retry/recovery not merged); a
  pre-dispatch `lane-blocked` record is excluded; the raw-malformed recovery fixture is genuinely unparseable.

### Mutation guards (6) — each demonstrated to FAIL, then reverted

| # | Mutation | Guard test | Result |
|---|---|---|---|
| 1 | recovery receipt omits its invocation id (`invocationId: undefined`) | A1 | fail → revert → pass |
| 2 | fixer stamps `config.fixerModel` (`fixerModel = config.fixerModel ?? laneFixerModel`) | B3 | fail → revert → pass |
| 3 | tournament/competitive stamp ONE model on every candidate role (`roleModel = "base-model"`) | C1 | fail → revert → pass |
| 4 | candidate role receipts share ONE invocation id (`recordRole(…, "fixed-id")`) | D2 | fail → revert → pass |
| 5 | missing structured-recovery invocation falls back to a config model instead of integrity-error | A4 | fail → revert → pass |
| 6 | `executedIds()` counts non-executed (`lane-blocked`) records | F2 | fail → revert → pass |

## Validation commands + results

- `pnpm build` — clean (tsc strict; typechecks `*.test.ts`).
- New conformance suite (tsx): **18 / 18 pass.**
- Directly-affected suites (phase11b-lane-authority, critic-recovery, fixer-lane, tournament, competitive,
  invocation-ledger, model-identity): **99 / 99 pass.**
- Production-config probe (`orchestrator.test.ts`, `--experimental-test-isolation=none`, project `.env`):
  **111 / 111 pass** (unchanged).
- Full suite `pnpm test`: **3665 tests, 3664 pass, 0 fail, 1 skipped** (was 3647 / 3646 / 0 / 1 → +18 new).
- No paid model calls (all providers are in-test doubles).

## Answers to the phase's audit questions

- **Can any execution receipt describe model/provider/lane independently of the ledger?** No. The three
  seams (recovery, fixer, tournament/competitive roles) now derive execution identity from the ledger record;
  a missing record is a fail-closed integrity error, not a config fallback. The remaining model-bearing
  receipts (`worker.semantic`, `worker.promotion`, `worker.escalation.retry`, `worker.cheap_retry`,
  `worker.model_decision`) are evidence/selection/transition/promotion receipts whose execution truth is
  authoritatively held by a ledger-linked `worker.role.*` receipt — none is an *independent* execution claim.
- **Is every model-backed tournament/competitive role individually attributable?** Yes — each candidate role's
  receipt references its own `candidate-role`-stage invocation with its own dispatched model, and the aggregate
  `worker.tournament` receipt enumerates every executed invocation once.
- **Is Phase 11 now fully confirmed?** Yes for the execution-receipt boundary: the ledger is the single source
  of execution truth and every execution/aggregate receipt now binds to it.
- **Are Phases 1–11B intact?** Yes — Phase 1/6 "dispatched==receipt", Phase 9 recovery policy, Phase 11B lane
  enforcement, and the 111/111 production probe are all unchanged.

## Explicitly NOT changed (scope discipline)

Critic-recovery substance, fixer triggers, lane selection, attempt identity, promotion authority, executed-test
policy, runtime-truth behavior, `SafetyAssessment`, roster behavior, CLI-level cost accounting, and Abina were
not touched. No push / tag / PR / release. No broad cleanup (one speculative unused `where()` helper I had added
during exploration was removed so the diff carries no dead code).

## Not globally fixed / follow-ups

- `worker.escalation.consult` records through `recordExternal` but its receipt does not yet surface the consult
  invocation id explicitly (out of the narrow 11C scope, which named recovery/fixer/tournament/competitive). A
  future pass could add `invocationId` to the consult receipt for symmetry.
- `worker.semantic` / `worker.promotion` intentionally remain evidence/promotion receipts keyed by
  `semanticEvaluationId`; if a future audit wants them to *also* carry the critic/builder invocation id inline
  (rather than via the linked role receipt), that is an additive, non-authority change.

## Commit

One focused commit: `fix(receipts): bind execution claims to the invocation ledger`. Not pushed.
