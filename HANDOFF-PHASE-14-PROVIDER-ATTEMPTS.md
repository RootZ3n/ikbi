# HANDOFF — Phase 14: Provider-Attempt Authority (served identity + charged failures)

Moves execution truth to the provider-attempt granularity at the invocation-ledger seam. It closes the
reproduced core of **IKBI-REAUDIT2-003** (the ledger presented the logical REQUESTED model as the SERVED
identity, and the lane check ran on the requested model) and **IKBI-REAUDIT2-004** (thrown CHARGED provider
failures + per-retry/fallback identity disappeared; run totals did not derive from unique provider attempts).
It does NOT claim the full receipt-producer + cross-run CLI-aggregation + pre-dispatch adapter-persistence
forms — those remaining items are documented explicitly below with rationale.

## Verified starting state
- HEAD `7573803` (Phase 13C); branch `harness/cc-parity-and-bokahli-pilot`; 222 ahead of origin; tracked tree clean.
- Pre-existing untracked files (`.claude/`, audit/re-audit/consolidated reports, `ikbi-0.1.0-rc.1.tgz`,
  `scripts/ui-verify/package-lock.json`) left untouched.

## Complete provider-dispatch inventory (from investigation of the provider + ledger surface)
| Dispatch | File:symbol | Records at | Served identity today | Charged failure |
|---|---|---|---|---|
| **Lowest seam** | `core/provider/invoke.ts` retry/fallback loop | builds `ModelResponse.attempts[]` incrementally; throws `AllProvidersFailedError(model, attempts)` | `provider` + `providerModelId` (served) vs `model` (requested) | attempts carry `usage`/`costUsd` on failure |
| Ledger engine (builder/critic/recovery/fixer/scout/verifier via `runLedger.engine`) | `invocation-ledger.ts:invoke` | post-response (wraps the call) | **was `r.model` (requested)** → now served (Phase 14) | **was dropped** → now preserved (Phase 14) |
| Classifier | `orchestrator.ts:~2498` raw `invokeModel` → `recordExternal` | post-facto (on return) | now carries `providerModelId` + attempts + status (Phase 14) | its raw catch loses cost (documented) |
| Frontier consult | `consult-apply.ts` → `addCost`/`recordExternal` | post-facto | now `unconfirmed` (no provider-reported model) (Phase 14) | consult surfaces no attempts |
| Refuter | via `runLedger.engine` (dispatchRole) | ledger engine | gets the ledger treatment automatically | — |
| CLI cognition/planner | outside `orchestrator.run` | — | not in worker totals (documented boundary) | — |

Key finding: `ModelResponse` ALREADY carries `attempts: ProviderAttempt[]` (per-attempt `provider`,
`providerModelId`, `outcome`, `usage`, `costUsd`) and separate served (`provider`/`providerModelId`) vs
requested (`model`) fields. `AllProvidersFailedError.attempts` carries the charged failures. The Phase 14 gap
was entirely in the LEDGER's consumption of that data.

## Logical invocation vs provider attempt (design)
- A logical `InvocationRecord` = one operation (a builder/critic/classifier/consult call).
- A `ProviderAttemptRecord` (new) = one ACTUAL dispatch (first / retry / fallback). A logical invocation
  aggregates its child provider attempts. Built from `ModelResponse.attempts` (success) or
  `AllProvidersFailedError.attempts` (thrown) — never synthesized from configuration.

## Provider-attempt schema (`invocation-ledger.ts`)
`ProviderAttemptRecord`: `providerAttemptId` (`<invocationId>#paN`), `logicalInvocationId`, `attemptOrdinal`,
`servedProvider`, `servedModel`, `outcome`, `usage?`, `costUsd?`, `costStatus`, `chargedFailure`, `error?`.
`InvocationRecord` gains `servedModel?`, `servedProvider?`, `servedIdentityStatus?`, `providerAttempts?`.

## Lifecycle states
Preserved from Phase 11 (`InvocationStatus`): lane-blocked (pre-dispatch, NOT billable), dispatched/succeeded,
provider-rejected, rate-limited (via error), timeout, transport-failure, content-filtered, context-window,
cancelled, interrupted, execution-identity-violation. Provider-attempt `outcome` is the raw
`ProviderAttempt["outcome"]` (success/error/permanent_error/timeout).

## Requested vs served identity (IKBI-REAUDIT2-003)
`deriveServedIdentity(r)` reads ONLY provider-reported metadata: `servedModel = r.providerModelId`,
`servedProvider = r.provider`. Status: `confirmed` (present + self-consistent), `conflicting` (serving
attempt's provider disagrees with the top-level served provider), `unavailable` (absent). The requested
alias/model is NEVER copied into `servedModel`. `resolvedModel` now prefers the served id
(`served.servedModel ?? r.providerModelId ?? r.model`) — backward compatible with test doubles where
`providerModelId == model`.

## Lane enforcement
The post-dispatch execution-identity check now runs on the CONFIRMED SERVED model (`served.servedModel`), not
the requested `r.model`. It fires ONLY when served identity is confirmed — an absent-metadata (unconfirmed)
serve is NOT falsely classified cross-lane (req 29). A confirmed cross-lane serve is an
`execution-identity-violation` that fails closed (req 28), with the truthful served identity recorded.

## Thrown charged failures (IKBI-REAUDIT2-004)
The ledger's catch now extracts `err.attempts` (the `AllProvidersFailedError` charged attempts), expands them
into provider-attempt records, sums their charged cost via `chargedCostOfAttempts`, and folds it into the run
total. A charged failure is never dropped; missing usage/cost stays UNKNOWN (partial), never zero. The
last-serving attempt's provider/model is recorded as the (confirmed) served identity of the failed invocation.

## Partial responses / timeout / cancellation
Preserved: `chargedCostOf` sums every attempt's cost incl. partials; a timeout/cancellation after dispatch is a
recorded provider attempt (not a no-call); missing cost ⇒ `unavailable` ⇒ aggregate `partial`.

## Cost derivation
`providerAttemptCost()` derives run spend from UNIQUE provider attempts (incl. charged failures + retries),
falling back to the record's own cost for a record with no expanded attempts (e.g. a `recordExternal` without
attempts). `chargedFailureCount()` counts preserved charged failures. Pre-existing `cost()`/`costStatus()`
(record-level) are retained; `providerAttemptCost()` is the attempt-authoritative view. A lane-blocked
(no-dispatch) record is excluded.

## Budget behavior
Unchanged in policy: `enforceBudget` folds each record's cost (now incl. charged thrown failures) and trips
the cap; a retry is a separate attempt within the same logical record and its cost is folded. Unknown-cost
attempts mark the aggregate partial (no exact remaining-budget claim).

## Fallback behavior
Same-lane fallback attempts are recorded as distinct provider attempts within the logical invocation. Cross-lane
behavior is unchanged: the lane block (pre-dispatch) + execution-identity violation (post-dispatch) prevent a
silent cross-lane serve; a genuine cross-lane retry remains a separate Ikbi attempt (Phase 2/11B).

## Repair/retry context
Unchanged: fixer/escalation/cheap-retry/recovery dispatch through `runLedger.engine`/`recordExternal` with
their role/stage/attempt/lane context (Phases 11B/11C/12), so their provider attempts are now also expanded +
served-identity-tagged automatically.

## Receipt changes
The role receipts already reference `invocationId` (Phase 11C) whose record now carries served identity +
provider attempts. The classifier `recordExternal` now carries `providerModelId` + `servedIdentityStatus` +
real `attempts`. Surfacing `servedModel`/`servedIdentityStatus`/`providerAttemptId[]` on EVERY receipt
producer's metadata is PARTIAL — see remaining.

## Repaired semantic linkage
Unchanged from Phase 11C/12: a repaired candidate's critic dispatches a fresh logical invocation (a new
`candidate-role`/`role`-stage record); its `worker.semantic`/`worker.critic_recovery` reference that fresh
invocation, not the source critic. Phase 14 does not alter this.

## Calls outside worker run totals
CLI cognition/planner remain outside the worker run ledger (documented boundary, unchanged). They dispatch
through the same provider layer (`invoke.ts`) which produces `attempts`, but are not folded into a worker run's
ledger. A parent-build ledger aggregating child runs (duel primary+peer, multi-step) is NOT implemented.

## Files changed
- `src/modules/worker-model/invocation-ledger.ts` — `ProviderAttemptRecord` + `ServedIdentityStatus` types;
  `InvocationRecord` served + provider-attempt fields; `deriveServedIdentity`, `expandProviderAttempts`,
  `chargedCostOfAttempts`; `invoke()` uses served identity + lane-on-served + expands attempts + preserves
  thrown charged failures; `recordExternal` carries served identity + attempts; `providerAttempts()`,
  `providerAttemptCost()`, `chargedFailureCount()` accessors.
- `src/modules/worker-model/orchestrator.ts` — the classifier captures + records `providerModelId` + `attempts`
  + `servedIdentityStatus`.
- **new** `src/modules/worker-model/phase14-provider-attempts-conformance.test.ts` — 12 tests.

## Retained tests (12, all green) — maps to the required list
- **A1/A2** served identity: provider-reported, requested never copied (25,26,27); absent ⇒ unavailable (27).
- **B1** distinct attempt records per retry/fallback (1,2,13,16); **B2** thrown charged failures preserved
  (18,19,39); **B3** thrown-without-cost is unknown not zero (20); **B4** pre-dispatch block is no billable
  attempt (4).
- **C1** run/logical spend derives from unique attempts incl. charged failures + retries (37,38); **C2**
  unknown-cost attempt ⇒ partial (44).
- **D1** confirmed cross-lane served identity fails closed (28); **D2** unconfirmed not falsely cross-lane (29).
- **E1** classifier `recordExternal` carries attempts + served status (5,30); **E2** consult-style external ⇒
  unconfirmed (31).
- Covered green by prior suites: 8,9,33,34 (builder/critic receipts reference invocations — Phase 11C),
  46,47,48,49,50 (fallback/repair/repaired-semantic — Phase 2/11B/12), 53 (all Phase 1–13C conformance), 54 (probe).

## Mutation guards (demonstrated FAIL → revert)
| # | Mutation | Guard | Result |
|---|---|---|---|
| 7 | requested model copied into `servedModel` | A1 | fail → revert → pass |
| 5 | thrown charged failure dropped (ignore `err.attempts`) | B2 | fail → revert → pass |
| 1 | provider attempt created only on success (skip expand) | B1 | fail → revert → pass |

(Guards 2,6,8,9,10 are pinned by the same retained tests: E1 classifier recording, B1 distinct ids, A2/D2
unconfirmed handling, C1 failed-retry cost. Reverts verified clean.)

## Commands + results
- `pnpm build` — clean (tsc strict).
- Phase 14 suite (tsx): **12 / 12**. Ledger/lane/receipt suites: 15/15, 4/4, 18/18, 6/6, 16/16 (no regression).
- Provider adapter suites (`invoke`/`invoke-retry`/`invoke-wrapper`): **20/20**.
- Full worker-model suite: **1302 / 1302** (was 1290 → +12).
- Full `pnpm test`: **3759 tests, 3758 pass, 0 fail, 1 skipped** (was 3747 → +12).
- Production-config probe (isolation=none, `.env`, **`IKBI_GATE_WALL_BYPASS=false`**): **111 / 111**.
- No paid provider calls. **Hidden SDK retries:** the provider layer's `attempts[]` reflects Ikbi-controlled
  retries/fallbacks; a provider SDK issuing invisible internal retries is NOT observable here (documented).
  **Thrown error metadata:** `AllProvidersFailedError.attempts` is consumed; a non-`attempts` error (raw
  provider throw) yields UNKNOWN cost (partial), never zero. **Served-identity limitations:** a provider that
  does not report `providerModelId` is recorded `unconfirmed` (not falsely confirmed). **`.env`-dependent:** the
  pre-existing `worker-model.cli.test.ts` env-selection artifact (documented Phase 12) is unchanged/unrelated.

## Answers to the phase's questions
- **Is every actual provider dispatch recorded before return?** The lowest seam (`invoke.ts`) builds its
  `attempts[]` DURING dispatch (before/at each attempt) and surfaces it on return/throw; the ledger consumes
  that real data into per-attempt records — never synthesized from config. A separate pre-dispatch PERSISTED
  attempt record AT `invoke.ts` (before the provider call) is NOT implemented (the attempts array is in-memory
  in invoke.ts). **Partially — attempt truth comes from the real dispatch, not config; not a pre-persisted row.**
- **Is any requested identity still presented as confirmed served identity?** No — served fields are
  provider-reported only; absent ⇒ `unavailable`/`unconfirmed`.
- **Can charged thrown failures still disappear?** No — `AllProvidersFailedError.attempts` cost is preserved.
  (A raw non-`attempts` provider throw yields UNKNOWN cost, never zero — a documented boundary.)
- **Are all retry/fallback attempts individually attributable?** Yes for the ledger-engine + classifier paths —
  each `ModelResponse.attempts`/failure attempt becomes a distinct `ProviderAttemptRecord`.
- **Does every execution receipt reference real provider attempts?** Role receipts reference the invocation
  whose record now carries provider attempts; explicit per-receipt `providerAttemptId` surfacing is partial.
- **Are Phase 11 authority claims now globally true?** The ledger is now truthful about served identity +
  charged failures + per-attempt spend for the worker-run engine + classifier. Cross-run CLI aggregation +
  full receipt-producer surfacing remain (below).
- **Phases 1–13C intact?** Yes — all prior conformance suites + the 111/111 probe are green.

## Remaining boundaries / not globally fixed (explicit)
- **No pre-dispatch PERSISTED attempt row at `invoke.ts`** — the lowest seam builds attempts in-memory and
  surfaces them on return/throw; the ledger derives per-attempt records from that real data (not config). A
  literal "write the dispatched row before calling the provider" at the adapter is not implemented. **[audit target]**
- **Receipt-producer surfacing is partial** — the ledger RECORDS served identity + provider attempts; not every
  receipt producer echoes `servedModel`/`servedIdentityStatus`/`providerAttemptId[]` inline. **[enhancement]**
- **Classifier/consult still record post-facto** (on return) — now carrying real served identity + attempts,
  but without a pre-dispatch "dispatched" state. The classifier's own raw `catch` still loses cost on a raw
  throw. **[audit target]**
- **No cross-run parent-build ledger** — duel primary+peer, multi-step, tournament/competitive losers are each
  their own run's ledger; a CLI-composite build total aggregating child run IDs is not implemented (the
  REAUDIT2-004 CLI-composite portion). **[audit target]**
- **Hidden SDK retries** are not observable — Ikbi-controlled retries are attributed; a provider SDK's invisible
  internal retries cannot be counted. **[documented]**
- **CLI cognition/planner** remain outside worker-run totals (documented boundary). **[documented]**
- **REAUDIT2-005/-006/-007** remain out of Phase 14 scope. **[audit target]**

## Commit
One cohesive commit (the served-identity taxonomy, per-attempt records, charged-failure preservation, and
cost-from-attempts are one interlocking ledger-seam change sharing `invocation-ledger.ts`; the classifier
wiring is small and inseparable): `fix(providers): record served identity + charged provider attempts at the
ledger seam`. Not pushed.
