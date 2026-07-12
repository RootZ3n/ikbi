# HANDOFF — Phase 8: Safety-Evidence Authority (IKBI-RT-005, SafetyLedger portion)

**Branch:** `harness/cc-parity-and-bokahli-pilot` · **Status:** complete, committed, NOT pushed
**Result:** `pnpm build` clean · `pnpm test` = **3587 tests, 3586 pass, 1 skip, 0 fail** (Phase 7 baseline 3555 → +32)

---

## 1. The finding, in one line

The run-scoped safety projection consumed by the adjudication core was named `SafetyLedger` — a name
that claims append-only evidentiary authority it does not have — and it carried one **manufactured
affirmative fact**: `gateWallAuthorized: boolean`, hard-set `true` at construction. That field asserted
*"the gate-wall authorized this promotion"* **before the gate-wall ever ran**. The runtime was
manufacturing affirmative safety evidence because a schema expected a value. That is exactly the failure
class IKBI-RT-005 names.

---

## 2. Pre-change safety-data inventory (every value, classified)

The projection was built in `orchestrator.ts` (the terminal, post-loop adjudication block) and consumed
ONLY by `decidePromotability(work, assessment, safety, critic)` in `adjudication/core.ts`.

| Field (pre-change) | Constructed as | Taxonomy | Verdict |
|---|---|---|---|
| `externalInjection` | `externalInjectionDetectedThisBuild` (neutralization chokepoint) | **Authentic fact** — observed by a named component | KEEP |
| `effectiveBreach` | `false` literal | **Unknown / not-applicable** — "no such veto raised here"; monotone-veto absence, not an affirmative "no breach happened" claim | KEEP (honest `false`) |
| `refuted` | `refuterDetail.refuted === true` (refuter role) | **Authentic fact** | KEEP |
| `killed` | `killedReason !== undefined` (kill-switch / budget) | **Authentic fact** | KEEP |
| `driftBlocked` | `false` literal | **Not-applicable** — a drift block rejects at ENTRY (before roles), so this terminal is unreachable under a block; `false` = "no such veto raised" | KEEP (honest `false`) |
| `gateWallAuthorized` | `true` literal | **MANUFACTURED AFFIRMATIVE FACT** — claims a downstream authority's determination that had not been made | **REMOVE** |

Key distinction preserved: a **monotone veto** field is `true` only when a concrete bad event was
OBSERVED by a named runtime component; `false` means *"no such veto was raised"* — the **absence of a
positive observation**, never a claim that a check ran and passed. `effectiveBreach:false` /
`driftBlocked:false` are honest under that semantics. `gateWallAuthorized:true` is NOT: it is an
affirmative claim about an authority that runs *after* this projection.

The type was **the ONLY genuinely synthesized affirmative fact.** Nothing else needed removal.

---

## 3. What changed

### 3a. `adjudication/contract.ts`
- Renamed `interface SafetyLedger` → **`interface SafetyAssessment`**. The docstring now states plainly:
  a DERIVED, run-scoped projection of authentic monotone vetoes that **NEVER authorizes a promotion** —
  it can only WITHHOLD (retain) green work, and even that is shadow/quarantined (Phase 3). The
  authoritative promotion boundary is the real gate-wall + `promoteCandidate()`'s stale-tree/CAS,
  DOWNSTREAM of this projection.
- **Removed** the `gateWallAuthorized` field entirely (the manufactured fact — not renamed, gone).
- Added a transitional deprecated alias so external references compile:
  `export type SafetyLedger = SafetyAssessment;`

### 3b. `adjudication/core.ts`
- Param + import renamed to `SafetyAssessment`.
- **Removed** the `if (!safety.gateWallAuthorized) return { action: "retain", reason: "governance-withheld" }`
  branch. The core no longer gates on a gate-wall determination it never made. A `promote` verdict is a
  **RECOMMENDATION**; the canonical authority (`promoteCandidate()` + real gate-wall) then gates it. The
  ordering comment documents this: the gate-wall is a downstream authority, deliberately not an input
  here (invariant: `decidePromotability` arity stays 4).
- Behavior-preserving: the removed field was always `true`, so the removed branch never fired. The change
  eliminates the manufactured fact without altering any decision.

### 3c. `adjudication/index.ts`
- Export list adds `SafetyAssessment` (keeps `SafetyLedger` alias for compat).

### 3d. `orchestrator.ts` (the sole construction site)
- Builds `const safety: SafetyAssessment` from the five authentic vetoes only — **no `gateWallAuthorized`**.
- Adds a **truthful provenance receipt** `worker.safety_assessment` recording:
  - `authority: "advisory-to-adjudication; NOT a promotion authorizer (gate-wall + promoteCandidate are authoritative)"`
  - `observedVetoes: { externalInjection, refuted, killed }` — the authentic observations
  - `notDeterminedHere: ["effectiveBreach", "driftBlocked", "gateWallAuthorized"]` — the honest disclosure
    of what this projection did NOT determine (including the removed gate-wall slot)
  - `adjudicationAction` / `adjudicationReason` / `mode` (shadow|authoritative) / `treeHash`
  - Receipt failure is swallowed — provenance must never break a build.

---

## 4. Authority map (after Phase 8)

| Concern | Authority | Notes |
|---|---|---|
| Is the work verified-good? | `WorkAssessment` (verifier) via `decidePromotability` | tree-bound; `executed` evidence required |
| Should a safety veto WITHHOLD green work? | `SafetyAssessment` monotone vetoes → **retain only** (I1: green work is never discarded) | advisory to adjudication; cannot promote |
| Does the build's goal align? | `CriticVerdict` → retain(critic-fail-exhausted) | |
| **May a candidate actually promote?** | **The real gate-wall + `promoteCandidate()`** (sole `workspaces.promote` caller; stale-tree/CAS) | THE authoritative boundary, DOWNSTREAM of everything above |
| In AUTHORITATIVE mode, whose verdict is terminal? | `decidePromotability` (Phase 3), still gated by the gate-wall; fails CLOSED when facts are unavailable | default is SHADOW (telemetry only) |

`SafetyAssessment` is **advisory**. It never appears on the authorization path.

---

## 5. Gate-wall integration (unchanged, re-proven)

- A **denying** gate-wall blocks promotion of green + unvetoed work; the low-level promote is never
  reached (E1).
- An **unwired** gate-wall denies **fail-closed** — the safety projection's silence is not authorization
  (E2).
- A **promoting** build routes through the ONE canonical authority and records `gateWallAllowed: true` —
  authorization is attributed to the gate-wall, not the safety projection (E3).
- Phase 3 quarantine preserved: `IKBI_LEGACY_COMPLETION=off` cannot autonomously promote over an
  integrator/gate deny (covered by the existing orchestrator + promotion-funnel suites).

---

## 6. Failure / trust / runtime-truth / cost interaction

- A safety veto yields **retain** ("green-withheld") — a categorically **non-failure** outcome, never
  `discard`. Green work is not laundered into a build failure (G1). Trust is not debited as a failure on
  a safety withhold.
- The `SafetyAssessment` feeds ONLY `decidePromotability` + its provenance receipt. It is **not** threaded
  into trust, cost, or routing (G2 asserts the sole consumer and the absence of a trust channel).
- `killed` (kill-switch / budget) → retain(adjudication-incomplete); a halted run is never fabricated into
  a promote (G3).

---

## 7. Conformance tests — `safety-evidence-conformance.test.ts` (32 tests)

- **A1–A5 (no manufactured affirmative fact):** construction has no `gateWallAuthorized`; the type
  declares no such field; the core never reads it; the type has exactly the five veto fields; `SafetyLedger`
  is a deprecated alias.
- **B1–B5 (recommend, never authorize):** promote carries no authorization flag; arity is exactly 4 (no
  gate-wall input); each veto independently withholds; `false` is "no veto raised" and cannot manufacture
  green; an observed veto withholds regardless of how clean everything else is.
- **C1–C4 (no promotion / no manufacture from safety code):** no adjudication module calls
  `workspaces.promote`; the orchestrator has exactly one promote caller; every veto is bound to a NAMED
  observation; no veto is a bare `: true` literal.
- **D1–D4 (truthful receipt):** authority string disclaims promotion authority; `notDeterminedHere` names
  the removed gate-wall slot; only observed vetoes + action + mode are recorded; a clean build reports veto
  absence (not an affirmative certificate) and still promotes via the downstream authority.
- **E1–E3 (gate-wall is the authoritative boundary):** deny blocks a green build; unwired denies
  fail-closed; a promote records `gateWallAllowed`.
- **F1–F4 (advisory cannot fabricate safety):** critic pass cannot override an authentic veto; the
  construction reads no role opinion; the **source-boundary guard** (audit req 25) rejects any synthetic
  affirmative token; an integrator "promote" opinion cannot ride a stale tree.
- **G1–G3 (non-interaction):** veto → retain not discard; safety feeds only adjudication; killed → retain.
- **H1–H4 (determinism / totality):** pure; promote binds the work tree; **monotone lattice** — across all
  2^5 safety states a promote occurs IFF every veto is false (exactly one state); no veto is silently
  dropped.

## 8. Mutation guards (8) — each demonstrated to FAIL under its regression, then reverted

| # | Regression injected | Caught by |
|---|---|---|
| 1 | re-add `gateWallAuthorized: true` to the orchestrator construction | A1 (also F3) |
| 2 | re-add `gateWallAuthorized` field to the `SafetyAssessment` interface | A2 |
| 3 | core reads `safety.gateWallAuthorized` to gate | A3 |
| 4 | core promotes despite a `refuted` veto (drop the OR-in) | B3 (also H3/H4) |
| 5 | adjudication core calls `workspaces.promote` | C1 |
| 6 | construct a veto from a literal `true` | C4 (also F3) |
| 7 | receipt drops `gateWallAuthorized` from `notDeterminedHere` (dishonest) | D2 |
| 8 | receipt authority string claims promotion authority | D1 |

Verification method: each regression was applied to the working-tree source, the guard test was run via
`tsx` (which executes despite type errors), confirmed `# fail 1`, then all three source files were
restored byte-for-byte (`RESTORED CLEAN`). No mutation remains in the committed tree.

---

## 9. Scope adherence

- No governed-exec / routing / lane / promotion-caller / candidate-binding / semantic / runtime-truth /
  fixer / classifier redesign. No Abina work. No public/multi-tenant hardening. No unrelated cleanup.
- No prior invariant weakened; Phase 3 promotion funnel + quarantine untouched. No existing test modified
  except the mechanical `SafetyLedger`→`SafetyAssessment` rename + removal of the always-`true`
  `gateWallAuthorized` fixture in `adjudication/core.test.ts` (the pinned contract genuinely changed).
- Untracked pre-existing items left alone: `.claude/`, `IKBI-RUNTIME-CONFORMANCE-AUDIT.md`,
  `ikbi-0.1.0-rc.1.tgz`, `scripts/ui-verify/package-lock.json`.

## 10. Files touched (staged in this commit)

```
src/modules/worker-model/adjudication/contract.ts        rename + remove field + alias
src/modules/worker-model/adjudication/core.ts            drop gate-wall gate; recommendation semantics
src/modules/worker-model/adjudication/index.ts           export SafetyAssessment
src/modules/worker-model/orchestrator.ts                 truthful construction + provenance receipt
src/modules/worker-model/adjudication/core.test.ts       rename + fixture update + reworded gate test
src/modules/worker-model/safety-evidence-conformance.test.ts   NEW — 32 conformance + 8 mutation guards
HANDOFF-PHASE-8-SAFETY-EVIDENCE.md                       this file
```

**Stop point:** Phase 8 only. No critic retry / prompt redesign, no CLI cognition cost ledger, no Abina,
no broad audit cleanup. Not pushed / tagged / published; no PR opened.
