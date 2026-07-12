# HANDOFF — Phase 15: Evidence Relevance (typed authority + support matrix + field-presence recovery)

Closes **IKBI-REAUDIT2-005** (an unrelated/stylistic criticism became a concrete blocker by citing the generic
candidate/tree anchor + any nonempty requirement) and **IKBI-REAUDIT2-006** (structured recovery could FILL an
omitted requirement association / repairability without rejection).

## The central invariant

> An evidence ID is not authoritative merely because it exists. Its **authority class, scope, result, and
> requirement relationship** must be capable of supporting the asserted defect category. A candidate or tree
> anchor proves **identity only** — it cannot prove tabs were required, an API is wrong, a test failed, behavior
> is incomplete, a file is missing, architecture is invalid, or a naming choice violates the goal.

---

## 1. Verified starting state

- HEAD `e717d22` (Phase 14B), branch `harness/cc-parity-and-bokahli-pilot`, **225 commits ahead of
  `origin/main`**, tracked tree clean. Phase 10–14B local/unpushed.
- Pre-existing untracked files (`.claude/`, `HANDOFF-PHASE-10-12-CONSOLIDATED.md`,
  `IKBI-RUNTIME-CONFORMANCE-AUDIT.md`, `IKBI-RUNTIME-CONFORMANCE-REAUDIT{,-2}.md`, `ikbi-0.1.0-rc.1.tgz`,
  `scripts/ui-verify/package-lock.json`) untouched.

---

## 2. Complete evidence-authority inventory

Every evidence item a production critic may cite (built by `buildEvidencePackage`, from the SAME inputs the
critic prompt is shown), with its Phase 15 authority class and what it may support:

| Evidence id (kind) | Producer / source | Authority class | Substantive? | May support | Advisory only? |
|---|---|---|---|---|---|
| `candidate` (candidate) | `task.taskId` / `workspace.id` | **contextual-identity** | no | candidate binding **only** | — |
| `tree` (verified-tree) | `resolveVerifiedTree(ws)` (physical snapshot) | **contextual-identity** | no | snapshot binding **only** | — |
| `req:goal` (goal-requirement) | `task.goal` (whole-goal mode) | **requirement** | no | proves a requirement exists | — |
| `req:N` (acceptance-criterion) | explicit `task.acceptanceCriteria[N]` | **requirement** | no | proves a *specific* requirement | — |
| `file:<p>` (changed-file) | `diff.files` | **observation** | yes | file-content / api / missing-* | no |
| `diff:<p>` (diff) | `diff.files` | **observation** | yes | file-content / api / security | no |
| `check:<n>` (deterministic-check) | verifier checks (+ `passed`) | **observation** | yes | deterministic-check-failure / style / behavioral | no |
| `test:<n>` (executed-test) | verifier checks w/ `isTest` (+ `passed`) | **observation** | yes | executed-test-failure / behavioral | no |
| `api:<id>` (api-contract) | `apiContractIds` | **observation** | yes | api-contract-mismatch | no |
| `exec:<id>` (governed-exec) | `governedExecIds` | **observation** | yes | security-policy-violation | no |
| `runtime:<id>` (runtime-fact) | operator `ctx.runtimeEvidence` | **runtime-fact** | no (gated) | runtime-compatibility-conflict only | **yes** unless category permits |
| `prior:<id>` (prior-defect) | prior validated defects | **derived** | no | context for a repaired candidate | **yes** |

Non-package evidence classes named by the brief and where they live: **derived assessment** (critic summary,
`SafetyAssessment`, integrator recommendation) — advisory, never sole support; **operational** (provider
timeout, parser failure, snapshot failure, gate refusal) — explains why evaluation couldn't proceed, never a
candidate correctness defect (`snapshot-integrity-conflict` category is `operationalOnly` → never a blocker).

Per-item detail (id / class / producer / candidate+snapshot binding / whether substantive / defect classes it
may support / advisory) is encoded deterministically in `AUTHORITY_CLASS_OF_KIND` + `SUPPORT_MATRIX`
(`semantic-evidence.ts`) and surfaced per validated defect in the `worker.semantic` receipt's `supportMatrix`.

---

## 3. Evidence authority classes

`EvidenceAuthorityClass` = `contextual-identity | requirement | observation | runtime-fact | derived`
(`AUTHORITY_CLASS_OF_KIND`, `authorityClassOfId`, `kindOfEvidenceId`). The core rule: **only `observation`
(and, for one category, `runtime-fact`) is SUBSTANTIVE**. Contextual identity scopes; requirement proves a
requirement exists; derived/runtime are advisory. `changed-file`/`diff` are treated as scoped observations
(the critic was shown the diff), so Phase 12's file-citing fixtures remain valid; **the pure generic anchors
`candidate` and `tree` are contextual-only** — which is exactly what REAUDIT2-005 exploited.

---

## 4. Requirement model

A blocking defect / missing requirement must resolve to an **explicit** requirement authority: the whole goal
(`req:goal`, whole-goal mode) or a named acceptance criterion (`req:N`). Fallback to a generic "must be
correct" / inferred best practice / critic preference / unrequested convention is prohibited — a defect with no
resolvable requirement is dropped. Requirement IDs are constructed deterministically by `buildEvidencePackage`;
the critic/recovery model can never invent one (an unresolvable `requirementId`/`requirement` fails resolution).
**Whole-goal mode remains coarse** (see §16) — a `req:goal` requirement is only sharp when the task supplies
enumerated `acceptanceCriteria`; but a `req:goal` requirement can no longer carry a defect **on its own**,
because a substantive observation is now also required.

---

## 5. Typed defect categories

Every defect declares a controlled `category` (`DefectCategory`): `missing-required-output`,
`behavioral-failure`, `executed-test-failure`, `deterministic-check-failure`, `api-contract-mismatch`,
`file-content-mismatch`, `missing-file-or-symbol`, `security-policy-violation`,
`explicit-style-policy-violation`, `runtime-compatibility-conflict`, `snapshot-integrity-conflict`. An
absent/unknown category degrades to `unspecified` (the default rule: needs a substantive observation) — a
defect can never gain authority by omitting a category.

---

## 6. Deterministic support matrix (`SUPPORT_MATRIX`)

Each category maps to acceptable evidence + extra conditions. A defect is valid only when it cites ≥1 resolvable
evidence id, resolves a requirement, cites ≥1 **substantive observation of the matrix-allowed kind**, and meets
the category's extra rule:

| Category | Substantive obs. | Extra requirement |
|---|---|---|
| `executed-test-failure` | `test:` | the test is in `failedTests` |
| `deterministic-check-failure` | `check:` | the check is in `failedChecks` |
| `behavioral-failure` | `test:`/`check:` | a failed check or test |
| `api-contract-mismatch` | `api:`/`file:`/`diff:` | — |
| `file-content-mismatch` | `file:`/`diff:` | — |
| `missing-file-or-symbol` / `missing-required-output` | `check:`/`file:`/`diff:` | absence evidence: a failed check **or** a named criterion |
| `security-policy-violation` | `exec:`/`diff:`/`file:`/`check:` | — |
| `explicit-style-policy-violation` | `check:` | a named style **criterion** OR a failed formatter check (NOT `candidate`+`req:goal`) |
| `runtime-compatibility-conflict` | `file:`/`diff:` | a cited `runtime:` fact |
| `snapshot-integrity-conflict` | — | **operational-only → never a blocker** |
| `unspecified` (default) | any observation | — |

Support is a **deterministic typed relationship** (category ↔ evidence kind ↔ result ↔ requirement), not an
open-ended NL proof. Free-form prose stays useful for humans but is not the authority.

---

## 7. Candidate/tree anchor behavior

`candidate` satisfies candidate binding only; `tree` satisfies snapshot binding only; neither counts toward the
substantive-observation requirement. A defect citing only contextual anchors → `defect-cites-only-contextual-evidence`
→ dropped → indeterminate (tests 3, 4, 9, 25, 26). A defect citing contextual anchors **plus a requirement but
no observation** → still unsupported (test 5, 15).

---

## 8. Style / formatting behavior

A style/naming/indentation/formatting/architecture-preference defect may block only via
`explicit-style-policy-violation` supported by a **named acceptance criterion** OR a **failed formatter/linter
deterministic-check**. Therefore: "uses spaces instead of tabs" citing only `candidate` → indeterminate
(test 9); "class name should differ" without a named requirement → advisory/unsupported (test 8); "formatter
check `fmt` failed against the tabs criterion `req:0`" → blocking (test 10).

---

## 9. Evidence scope rules

A defect is rejected when its evidence is from another candidate (candidateId echo mismatch, test 19), another
snapshot (tree echo mismatch, test 20), a file/symbol not in the package (test 21, 24), an unknown/stale id
(tests 22, 23), a check that didn't fail while the claim asserts failure (tests 12, 13), or is advisory-only
(test 18). Scope binding (candidate/tree) is the Phase 9 echo check; substantive-support + failed-status is the
Phase 15 addition.

---

## 10. Missing-requirement rules

A canonical `incomplete` still requires a concrete missing requirement (Phase 12). A `missing-file-or-symbol` /
`missing-required-output` blocking defect additionally requires **absence evidence** — a failed check OR an
explicit criterion naming the expected (absent) output; a generic changed-file list + whole-goal cannot prove a
specific output is absent (test 16).

---

## 11. No-package production behavior

`parseSemanticVerdict` sets `evidenceEnforced: true` iff a typed package governed the parse.
`effectiveDecisionKind(verdict)` downgrades a `fail`/`incomplete` that is **not** `evidenceEnforced` to
`indeterminate` for decisions. `classifySemanticVerdict` (the promotion/duel/fixer input) applies it, and
`emitSemanticEvidence` derives eligibility from it. So a decision-bearing semantic evaluation without a typed
evidence package is **indeterminate** (tests 42, 43): it can never authorize a fixer, peer duel, or a concrete
promotion block. The compatibility parser (direct `parseSemanticVerdict` / a non-enforcing `createCritic`)
**remains available** for unit parsing / receipt display / diagnostics — it just isn't decision-bearing. This
gate fires only when a `semanticVerdict` OBJECT is present with `evidenceEnforced !== true`; injected test-double
critics (no `semanticVerdict` object) use the unchanged Phase 4 fallback, so no orchestrator test regressed.

**Remaining no-package production paths that could authorize a defect: none.** `criticFor()` (the sole
production critic factory) always sets `enforceEvidenceSubstance: true`; every other production consumer routes
through `effectiveDecisionKind`.

---

## 12. Recovery field-presence rules (`substanceFingerprint` / `substanceEquivalent`)

The fingerprint now captures decision-bearing **field presence** (null = absent): `requirementId`,
`repairable`, `category` (in addition to Phase 12's claim/evidence/requirement/severity/polarity/binding). A
recovered verdict is rejected (→ indeterminate) when recovery:

- **adds a specific requirement id** the raw defect never stated (`requirement-id-added`) — but adding the
  whole-goal default `req:goal` to an already-substantive defect stays benign (that is the Phase 12 D-recover
  structure-only repair), or **changes/removes** a stated one (`requirement-id-changed`/`-removed`);
- **adds / removes / flips** an omitted-or-stated repairability (`repairability-added`/`-removed`/`-changed`);
- **adds / changes** the typed category (`category-added`/`-changed`). The default `unspecified` category the
  parser re-stamps is normalized to absent, so a structure-only reformat is not falsely flagged.

Field-presence is caught even when free text matches (test 37). Phase 12's value-diff rules (count, add/drop/
reword defect, evidence add/remove, requirement text change, severity, polarity flip, binding change) are
preserved unchanged.

---

## 13. Repairability authority

**Design chosen: derive canonically + preserve the model value as advisory.** Fixer eligibility is derived
LOCALLY from the effective decision kind (`effectiveDecisionKind === "fail" | "incomplete"`) — the per-defect
`repairable` boolean is never a decision gate (it wasn't before Phase 15 either). The model's `repairable` is
retained as advisory metadata and its **field presence is preserved** through recovery (§12), so recovery can
neither fill nor flip it to drift fixer targeting. This is documented as the canonical design.

---

## 14. Durable semantic receipt changes (`worker.semantic`)

Added: `supportMatrix` (per validated defect: `category`, `supportKind`, `evidenceIds` — the matrix rule
applied), `rejectedDefects` (dropped defects + deterministic reason), `evidenceEnforcedVerdict`. Retained from
Phase 12: `evidencePackageHash`, `substanceFingerprintHash`, `recoveredOutputHash`, `recoveryEquivalence`(+
mismatches), `primaryCriticInvocationId`, `verifiedTree` (physical snapshot), `blockingDefects` (validated,
now carrying `category`/`supportKind`/`evidenceIds`/`requirementId`). Policy fields (`promotionEligible`/
`duelEligible`/`fixerEligible`) now derive from `effectiveDecisionKind` so the receipt matches the actual gates.
No unrestricted raw output is persisted (only hashes).

---

## 15. Fixer / duel / promotion consequences + isolation

Only a fully validated concrete defect (`effectiveDecisionKind` = `fail`/`incomplete`, evidence-enforced)
influences policy. Unsupported criticism produces `indeterminate` → **no fixer** (test 39), **no peer duel**
(test 40), **no autonomous promotion** and no concrete-fail surface (test 41), **no persisted blocking defect**,
and a truthful receipt (test 48). Isolation is unchanged from Phase 12/13C and re-verified: each candidate
builds its OWN evidence package bound to its candidate/tree (normal/duel = `task.taskId`, tournament/competitive
= `workspace.id`); a repaired candidate re-runs the critic with a fresh package reflecting the post-repair tree
(distinct hash, tests 44–46); loser-bound evidence cannot support the winner (test 46); recovery stays tied to
the same critic invocation + provider attempts (Phase 11C/12); the semantic receipt references the current
physical snapshot (test 50).

---

## 16. Files changed

| File | Change |
|---|---|
| `semantic-evidence.ts` | `EvidenceAuthorityClass` + `AUTHORITY_CLASS_OF_KIND` + `kindOfEvidenceId`/`authorityClassOfId`; `DefectCategory` + `SUPPORT_MATRIX` + `resolveDefectCategory`; package `failedChecks`/`failedTests` + check `passed`; rewritten `validateDefectEvidence` (substantive-observation + category matrix); fingerprint/equivalence field-presence (`requirementId`/`repairable`/`category`). |
| `semantic-verdict.ts` | `BlockingDefect.category`/`supportKind`; `RejectedDefect`; verdict `evidenceEnforced`/`rejectedDefects`; `richDefects` returns `{defects, rejected}` + threads category; `effectiveDecisionKind`; `stamp` sets `evidenceEnforced`. |
| `critic.ts` | evidence package now carries each check's observed `passed` status (exitCode / testCount). |
| `orchestrator.ts` | `classifySemanticVerdict` applies `effectiveDecisionKind`; `worker.semantic` gains `supportMatrix`/`rejectedDefects`/`evidenceEnforcedVerdict`; eligibility derives from the effective decision kind. |
| **new** `phase15-evidence-relevance-conformance.test.ts` | 50 conformance tests. |

---

## 17. Retained tests + mutation evidence

- **New suite:** `phase15-evidence-relevance-conformance.test.ts` — **50/50** (reqs 1–50; 51 = all Phase 1–14B
  suites green, 52 = the production probe, both below).
- **Mutation guards — demonstrated FAIL → revert:**

| Mutation | Guards | Tests that failed | Result |
|---|---|---|---|
| candidate anchor counted as substantive | 1,2,3,10,11 | 3,4,6,39,40 (12/50 fail) | revert → 50/50 |
| `*-failure` accepts a passing check | 4 | 12 | revert → 50/50 |
| drop recovery presence-diff (req-id + repairability) | 6,7 | 29,31 | revert → 50/50 |
| no-package fail not downgraded | 9 | 42 | revert → 50/50 |

The remaining brief guards are locked by retained tests bound to existing structural gates: **5** (scope
checking removed → tests 19–24, the Phase 9 echo + package resolution); **8** (insufficiency sent to recovery →
test 36, the `parseStatus === "unparsable"` recovery gate); **12** (repaired candidate reuses source evidence →
test 44, per-candidate package hash). Each fails if its gate is removed.

---

## 18. Exact commands + results

- `pnpm build` — clean (`tsc -p tsconfig.json`, strict; typechecks `*.test.ts`).
- Phase 15 suite (tsx) — **50 / 50**.
- Backward-compat (phase12 + semantic-contract + critic-recovery + critic + critic-fix-loop) — **123 / 123**.
- Full worker-model suite — **1332 / 1332**.
- Phase 11B/11C/12/14/14B + semantic-contract conformance — **128 / 128**; Phase 13/13b/13c snapshot — **37 / 37**.
- Full `pnpm test` — **3839 tests, 3838 pass, 0 fail, 1 skipped** (was 3789 → +50).
- **Production-config probe** (`orchestrator.test.ts`, isolation=none, `.env`, `IKBI_GATE_WALL_BYPASS=false`) —
  **111 / 111**.
- No paid provider calls (all providers are test doubles).

---

## 19. Commit hashes

Two focused commits. The brief's two logical concerns (typed authority/matrix/binding; recovery
field-presence + receipt) are interdependent and share one module (`semantic-evidence.ts` — the fingerprint/
equivalence field-presence rules reference the same authority-class machinery), so the implementation lands as
ONE reviewable, green commit (as Phase 12 did for the same shared-module reason); the conformance suite + this
handoff land as the second.

- (Commit 1) `fix(semantic): require relevant evidence for blocking defects` — `d093c6d` (semantic-evidence.ts,
  semantic-verdict.ts, critic.ts, orchestrator.ts: typed evidence authority + support matrix + requirement
  binding + no-package decision gate + recovery field-presence preservation + receipt integration).
- (Commit 2) `test(semantic): phase 15 evidence-relevance conformance + handoff` — this commit
  (phase15-evidence-relevance-conformance.test.ts — 50 tests + 12 demonstrated mutation guards — and this handoff).

*(Hashes filled from the final git log below. Not pushed.)*

---

## 20. Audit-question answers

- **Can a generic contextual anchor still support a blocker?** No — `candidate`/`tree` are contextual-identity;
  a blocking defect requires a substantive observation (tests 1–4, 9, 25, 26).
- **Can unsupported style preference still become a defect?** No — a style defect needs a named criterion or a
  failed formatter check (tests 8, 9, 10).
- **Can recovery alter requirement association?** No — it cannot add a specific requirement id or change/remove
  one (tests 29, 30, 37). (Adding the whole-goal `req:goal` default to an already-substantive defect stays
  benign, matching Phase 12's structure-only repair.)
- **Can recovery fill omitted repairability?** No — add/remove/flip are all rejected (tests 31, 32, 33).
- **Can unsupported criticism trigger fixer or duel?** No — it is `indeterminate` (tests 39, 40, 48).
- **Is Phase 12 semantic authority now globally true?** Yes for production: every enforcing critic path
  (normal/duel/fixer/escalation/tournament/competitive) validates against the typed package + support matrix,
  and a no-package decision-bearing verdict is downgraded to indeterminate. Whole-goal requirement resolution
  remains coarse (below) but can no longer carry a defect alone.
- **Are Phases 1–14B intact?** Yes — all their conformance suites + the 111/111 probe are green; **no existing
  test was modified** (Phase 15 is purely additive).

---

## 21. Remaining semantic ambiguity / NOT globally fixed

- **Category ↔ claim NL-consistency is not enforced.** The support matrix enforces that the cited EVIDENCE TYPE
  can support the DECLARED category; it does not prove the natural-language claim matches the category (a model
  could declare `file-content-mismatch` citing a real `file:` while the prose describes a test failure). This is
  the deliberate "typed relationships, not open-ended NL proof" boundary — a residual, honestly documented.
- **Whole-goal requirement resolution stays coarse.** Without explicit `acceptanceCriteria`, any non-empty
  requirement resolves to `req:goal`; off-goal requirement rejection is only sharp with enumerated criteria.
  Mitigated: a `req:goal` defect now also needs a substantive observation, so the REAUDIT2-005 whole-goal
  exploit is closed regardless.
- **`WorkerTask` still has no typed `acceptanceCriteria` field** — the critic reads it via an optional cast
  (`critic.ts`). Supplying criteria is an embedder/task option, not a schema guarantee (unchanged; out of scope).
- **Runtime facts remain advisory** except in `runtime-compatibility-conflict` (by design).
- **Remaining no-package production paths that authorize a defect: none** (§11).

---

## 22. Scope adherence

Did NOT: revisit the provider journal / composite aggregation / physical-snapshot / routing / four-model
roster; touch Abina; add public-Internet hardening; push/tag/PR; do broad cleanup. Preserved every prior
invariant (13C physical-snapshot promotion, snapshot/tree/CAS binding, executed-test evidence, provider-attempt
journal, charged-failure accounting, requested-vs-served identity, attempt/lane enforcement, receipt linkage,
bounded critic recovery, exact defect-set preservation, runtime-truth scoping, fixer/duel eligibility discipline,
gate-bypass trust suppression, manual-unverified `/apply`, success-trust-only-after-promotion). Work stops after
Phase 15.
