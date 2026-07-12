# HANDOFF — Phase 14B: Dispatch Journal + Composite Execution Authority

**Closes the "final closure" pass on invocation/cost authority (IKBI-REAUDIT2 follow-through).**
The authority invariant this phase makes true:

> **Every provider dispatch is recorded before the provider is called, finalized from the response
> or failure, and included exactly once in its logical invocation, run, and parent composite
> operation.**

---

## 1. Verified starting state

- **HEAD at start:** `19f8a97` — `fix(providers): record served identity + charged provider attempts at the ledger seam` (Phase 14).
- **223 commits ahead of `origin/main`**, tracked tree clean.
- Pre-existing untracked files left untouched: `.claude/`, `IKBI-RUNTIME-CONFORMANCE-AUDIT.md`,
  `ikbi-0.1.0-rc.1.tgz`, `scripts/ui-verify/package-lock.json`.
- **Nothing pushed.** No tags/PR/publish.

---

## 2. The lowest provider-call seam (inventory)

- **`InvocationLedger.invoke()`** (`src/modules/worker-model/invocation-ledger.ts`) is the universal
  in-run dispatch seam. Every role (`scout/builder/critic/verifier/integrator`, repair, multi-step
  children) calls the provider through `ledger.engine.invokeModel`, which routes to `invoke()`.
- **`InvocationLedger.recordExternal()`** is the seam for provider calls made by a raw helper that
  does not go through `engine.invokeModel` — the **classifier**, **frontier consult**, and **refuter**.
  They journal through the ledger (a real ledger-derived id), never a post-facto synthetic id.
- Below the ledger sits **frozen-core `ProviderInvoker`** (`src/core/provider/invoke.ts`): the
  fallback chain over routes + a per-route retry loop, returning `ModelResponse.attempts` or throwing
  `AllProvidersFailedError.attempts`. This is a **shared singleton decoupled from the per-run ledger**
  — see §11 for the boundary this creates.

---

## 3. Pre-dispatch journal design (Part A)

`invoke()` now **allocates + records a `dispatched` record BEFORE calling the provider**, then
**finalizes that same record in place** — it is never replaced by a record created after return:

```
const pendingIndex = this.records.length;
this.records.push({ ...base, status: "dispatched", costStatus: "unavailable", servedIdentityStatus: "unavailable" });
try {
  const r = await this.deps.invokeModel(effReq);
  ... this.records[pendingIndex] = { ...finalized from the real response... };   // in place
} catch (err) {
  ... this.records[pendingIndex] = { ...finalized from the thrown failure... };  // in place
}
```

- **Record count/order is preserved** (one dispatched record → finalized in place = still one record),
  so all prior tests and cost/aggregate derivations are unchanged.
- All three terminal paths finalize `records[pendingIndex]`: the **success** path, the
  **post-dispatch lane-violation** path (`execution-identity-violation`, charged cost preserved), and
  the **thrown-failure** path (charged failures preserved, unknown cost stays unknown).
- Two teardown accessors were added:
  - `pendingAttempts()` — dispatched-but-not-finalized records (a hung/in-flight call is visible here
    **before its promise resolves**).
  - `finalizeStalePending()` — stamps every still-`dispatched` record `unknown-terminal` (with
    `completedAt`), **preserving the attempt — never deleting it**.

### Relationship to `ModelResponse.attempts` / `AllProvidersFailedError.attempts`

These are **no longer the first point an attempt comes into existence.** The pre-dispatch record
exists first; the returned/thrown attempt metadata **ENRICHES** it (served identity, per-attempt
cost, charged failures) via `expandProviderAttempts` — one logical record, N provider-attempt
children, **no duplication** (test A7).

### Retry / timeout / cancellation lifecycle

- **Explicit orchestrator-level retries** (fixer, iterative-repair, escalation, cheap-retry,
  structured-recovery) are **distinct `invoke()` calls** → each gets its own pre-dispatch record with
  its own `retryKind` + `parentInvocationId` reference, recorded before dispatch.
- **Provider-managed retries inside a single `ProviderInvoker` call** surface as multiple entries in
  `ModelResponse.attempts` and enrich the one logical record's `providerAttempts[]` — observable and
  costed, but the SDK/route-loop's internal retry granularity is bounded by what the core reports
  (see §11).
- **Timeout / cancellation / hang:** the pre-dispatch record survives. A thrown timeout finalizes it
  in place (`status: "timeout"`, cost unknown-not-zero). A truly abandoned promise stays `dispatched`
  and is stampable to `unknown-terminal` by `finalizeStalePending()` (tests A3, A4, A5, A12).

### Classifier / frontier-consult / refuter

Route through `recordExternal` — journaled with a real ledger id **before** any synthetic id is
needed (A13). A classifier/consult that makes **no** provider call creates **no** attempt (A14).

### Served identity

The in-flight `dispatched` record carries **no** served identity (`servedIdentityStatus:
"unavailable"`, no `servedModel`) — it is filled only from the provider response (A8). The requested
alias is **never** promoted to a confirmed served identity (A9). (Phase 14 taxonomy preserved:
`confirmed`/`unconfirmed`/`conflicting`/`unavailable` via `deriveServedIdentity`.)

### Receipt linkage

Every executed record keeps its `invocationId` (logical-invocation id) and, when the provider
returned/threw attempts, its `providerAttempts[]` (each `logicalInvocationId#pa{n}`). `executedIds()`
gives the de-duplicated linkage a strategy/summary receipt references; `lastFor(role,stage)` gives the
per-role authority. Charged failures remain in `providerAttempts()` / `chargedFailureCount()`.

---

## 4. Composite execution authority (Part B)

New module **`src/modules/worker-model/composite-ledger.ts`** — `CompositeOperationLedger`, a PURE
parent authority (it never dispatches a provider). It aggregates child worker runs by the **union of
unique provider-attempt ids**:

- `compositeOperationId`, `sourceId`, `strategy`; `registerChild()` records a child's compact
  provider-attempt projection with a `ChildRunRole`
  (`primary | peer | tournament-candidate | competitive-candidate | evaluator | step | finalizer |
  repair | cognition | planning | worker`).
- `providerAttemptIds()` — union, de-duplicated, dispatch order.
- `compositeCost()` — sums UNIQUE attempts (a shared id counted once); **`partial`** if any attempt's
  cost is `unavailable`; losing/failed children always included; the selected child never erases cost.
- `summary()` — durable audit projection (child roles, outcomes, selected flag, cost).

### Why union-of-unique-ids is correct for every strategy

- **Duel** (primary run + peer run) and **multi-step** (a run per step + finalizer) are **separate
  runs with disjoint, taskId-prefixed attempt ids** → union == plain sum, and the **losing/intermediate
  child spend is included** (tests B2, B3, B6, B13).
- **Tournament / competitive** candidates + evaluator may share one ledger → overlapping ids are
  **counted once** (B4, B5, B7). This makes the aggregation robust for both topologies with no
  double-count.

### Worker-run projection

`WorkerResult` gained (in `contract.ts`) a compact, optional projection for parent aggregation:

```
readonly costStatus?: "complete" | "partial";
readonly providerAttempts?: readonly { providerAttemptId: string; costUsd?: number;
  costStatus: "measured" | "measured-zero" | "unavailable" }[];
```

Populated at the main `orchestrator.run()` return from `runLedger.providerAttempts()` /
`runLedger.costStatus()`. A worker run's **own scoped cost is unchanged** — the composite is a DERIVED
parent view, not a rewrite of the children (B10).

### CLI aggregation

`cli.ts` (the `build` path) now, **when a conditional duel actually dispatched a peer**, builds a
`CompositeOperationLedger` from BOTH children (primary + peer) and surfaces the composite total:

- `--json`: adds `compositeCostUsd` / `compositeCostStatus` / `compositeProviderAttempts` alongside
  the scoped `costUsd`.
- `--cost`: prints `formatCompositeCost(...)` (both children, the winner marked, the union total, a
  `partial` marker if any attempt cost is unknown).
- A single-child operation prints **no** composite (its scoped total is already honest).

---

## 5. Budget scopes

- **attempt / logical-invocation / run**: enforced inside `InvocationLedger` (`enforceBudget()` on the
  per-run `total`). Explicit orchestrator retries are further `invoke()` calls **through the same
  ledger**, so they cannot evade the run budget.
- **composite**: the budget cap remains **worker-run-scoped** (unchanged — no budget redesign, per
  scope restrictions). The composite ledger **surfaces** the true multi-run total (so the losing
  peer/intermediate spend is visible) without moving the enforcement point. This is documented rather
  than silently changed.

---

## 6. Files changed

| File | Change |
|---|---|
| `src/modules/worker-model/invocation-ledger.ts` | Pre-dispatch `dispatched` record + in-place finalize (3 paths); `pendingAttempts()`, `finalizeStalePending()`. |
| `src/modules/worker-model/composite-ledger.ts` | **NEW** — `CompositeOperationLedger` parent authority. |
| `src/modules/worker-model/contract.ts` | `WorkerResult.costStatus?` + `WorkerResult.providerAttempts?` projection. |
| `src/modules/worker-model/orchestrator.ts` | Populate the two `WorkerResult` fields at the main `run()` return. |
| `src/modules/worker-model/cli.ts` | Duel builds a composite; `formatCompositeCost()`; JSON + `--cost` surface the composite total. |
| `src/modules/worker-model/phase14b-dispatch-journal-conformance.test.ts` | **NEW** — 30 conformance tests (Part A journal + Part B composite + CLI render). |

---

## 7. Retained/added tests + commands & results

- **New suite:** `phase14b-dispatch-journal-conformance.test.ts` — **30/30 pass** (A1–A15 journal,
  B1–B13 composite, C1–C2 CLI render).
- **Prior authority suites:** `phase14-provider-attempts` + `phase11b-lane` + `phase11c-receipt` +
  `invocation-ledger-conformance` — **49/49 pass** (invariants intact).
- **Full build:** `pnpm build` → clean (`tsc -p tsconfig.json`, strict, typechecks `*.test.ts`).
- **Full suite:** `pnpm test` → **3788 pass / 0 fail / 1 skipped** (3789 total).
- **Production probe** (real gate-wall, `.env` loaded, `IKBI_GATE_WALL_BYPASS=false`):
  `orchestrator.test.ts` → **111/111 pass**.

### Mutation evidence (guards bite → reverted)

- **Part-A guard** — moved the pre-dispatch push to AFTER the provider returns ("attempt created only
  after return"): **A1, A4, A8 fail** (26/30). Reverted → 30/30.
- **Part-B guard** — made `compositeCost()` count only the selected child ("winner-only aggregate"):
  **B2, B3, B12 fail** (18/30). Reverted → 30/30.

These directly demonstrate the enumerated mutation classes: attempt-only-after-return, hung-record
deletion, winner-only duel aggregate, dropped losing/failed child.

---

## 8. Commit hashes

- (Commit 1) `fix(providers): journal attempts before dispatch` — `1ed4b44` (invocation-ledger.ts).
- (Commit 2) `fix(cost): aggregate complete composite executions` — this commit (composite-ledger.ts,
  contract.ts, orchestrator.ts, cli.ts, the conformance suite, this handoff).

225 commits ahead of `origin/main`. **Not pushed.**

---

## 9. Honest boundaries (what is NOT globally fixed)

1. **Process-crash durability.** `finalizeStalePending()` stamps in-flight dispatched records
   `unknown-terminal` **when called** (CLI hard-interrupt / run teardown). A `kill -9` / power loss
   cannot run JS teardown — the pre-dispatch record is in memory, not a write-ahead log. Within a
   normal `run()`, every dispatch finalizes in place before `invoke()` returns, so nothing is left
   pending; the accessor is the teardown hook, not an on-crash guarantee.
2. **Frozen-core `ProviderInvoker` internal retries.** The pre-dispatch record wraps the **ledger**
   seam, not core `invoke.ts`. A route-loop retry inside one core call is observable only through the
   `ModelResponse.attempts` the core reports; a hidden SDK-managed retry that the core does not surface
   is marked by cost uncertainty, not a distinct pre-dispatch record. Re-architecting `invoke.ts` to
   pre-journal each route attempt was **out of scope** (frozen core) and is the remaining deepening.
3. **Budget enforcement stays worker-run-scoped** (§5) — surfaced-but-not-enforced at the composite
   level, by design and documented.
4. **CLI composite wiring covers the duel** (the clearest multi-run CLI operation). Multi-step /
   tournament / competitive / cognition+worker composites are supported by the module + `WorkerResult`
   projection and unit-proven (B4–B9), but the orchestrator/CLI call sites for those paths surface
   the composite where they already aggregate; broader call-site wiring was kept minimal per scope.

### Global-truth check

- **Every provider dispatch recorded before return?** Yes at the ledger seam (all roles + classifier/
  consult/refuter). Bounded below by core `invoke.ts` (§9.2).
- **Can a charged failure disappear?** No — preserved on the finalized-in-place record and in
  `chargedFailureCount()` (A11).
- **Does every composite include losing/failed work?** Yes — losing/failed children are always in the
  union; the selected child never erases cost (B2, B3, B11, B12).
- **Phase 11 + 14 authority still globally true?** Yes — 49/49 prior authority tests + 111/111 probe.
- **Phases 1–13C intact?** Yes — full suite 3788/0. 13C snapshot, mutation fencing, tree/CAS, lane,
  requested-vs-served, charged-failure, semantic policy, manual `/apply`, gate-bypass trust
  suppression, runtime-truth scoping, success-trust ordering all preserved.

---

## 10. Scope adherence

No snapshot/lease redesign, no semantic-relevance change, no routing/roster change, no Abina, no
public-Internet hardening, no push/publish/tag/PR, no broad cleanup. Work stops after 14B.
