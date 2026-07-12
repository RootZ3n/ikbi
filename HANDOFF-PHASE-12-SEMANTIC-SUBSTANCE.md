# HANDOFF — Phase 12: Semantic Substance (evidence-bound defects + substance-preserving recovery)

Closes **IKBI-REAUDIT-003** and the Phase 11C preflight exception (`worker.escalation.consult`).

## The invariant

> A recovered critic response is accepted only when deterministic LOCAL comparison proves its decision-bearing
> substance is equivalent to the recoverable substance already present in the original response. And a blocking
> defect is concrete only when it cites resolvable evidence from the finite package the critic was shown. If
> equivalence cannot be proven, or a defect is unsupported, the semantic result is `indeterminate` (fail-closed).

## Verified starting state

- HEAD `59121eb`; branch `harness/cc-parity-and-bokahli-pilot`; tracked tree clean; Phase 10–11C local/unpushed.
- (The brief's "six commits ahead" is stale — the branch is 218 ahead of `origin/main`; the load-bearing facts
  held: HEAD = 59121eb, clean tracked tree, pre-existing untracked files untouched.)
- Pre-existing untracked files (`.claude/`, `IKBI-RUNTIME-CONFORMANCE-AUDIT.md`,
  `IKBI-RUNTIME-CONFORMANCE-REAUDIT.md`, `ikbi-0.1.0-rc.1.tgz`, `scripts/ui-verify/package-lock.json`) untouched.

## Root cause of IKBI-REAUDIT-003

Two mechanisms let syntactic specificity masquerade as evidentiary support:
1. **`semantic-verdict.ts` fell back**: `flattenEvidence(d.evidence, claim)` fell back a missing evidence to the
   defect's own CLAIM, and `requirement` fell back to the WHOLE GOAL — so a defect with no real evidence parsed
   as a concrete `fail`, and every requirement was trivially "part of the goal".
2. **`critic-recovery.ts` compared coarsely**: `recoveredPreservesSubstance` compared only a verdict-polarity
   token and a keyword-COUNT of defect-like signals (`rawDefectSignals`). So `{"issues":[…]}` (1 signal) + a
   completely unrelated recovered defect passed the guard, and a defect-bearing `{"summary":"…bypassed…"}`
   recovered to `pass` passed too. Recovery could invent, drop, or re-scope substance.

## Full pre-change transformation inventory (production critic → verdict → consumers)

Traced by 5 parallel read-only agents; reconciled below. `file:symbol` / behavior for each stage:

| # | Stage | File : symbol | In → Out | Can invent? | Can erase? |
|---|---|---|---|---|---|
| 1 | Critic input | `critic.ts` (req at 406–431) | ctx (goal, verifier checks, runtime evidence w/ `.id`, diff, builder detail) → `ModelRequest` (untrusted DATA) | — | — |
| 2 | Candidate/tree bind | `critic.ts:385-386` | `candidateId = ctx.task.taskId`; `verifiedTree = resolveVerifiedTree(ws)` | no | no |
| 3 | Primary invoke | `critic.ts:431` `ctx.engine.invokeModel` | request → response (ledgered, stage "role"/"candidate-role") | — | — |
| 4 | Raw extract | `critic.ts:433` | `response.content` → `rawOutputHash` | — | — |
| 5 | Infra detect | `critic.ts:446-461` | finishReason content_filter/length → `infrastructure-failure` (pre-parse) | no | no |
| 6 | Parse | `semantic-verdict.ts:parseSemanticVerdict` | content → `SemanticVerdict` | **YES (evidence→claim, requirement→goal)** | — |
| 7 | Recovery eligibility | `critic-recovery.ts:classifyRecoveryEligibility` | raw → {eligible} | — | — |
| 8 | Recovery invoke | `critic.ts:558` (stage "structured-recovery") | one reformat call (ledgered, Phase 11C) | — | — |
| 9 | Recovery parse | `critic.ts:571` | recovered content → verdict | **YES** | — |
| 10 | Substance guard | `critic-recovery.ts:recoveredPreservesSubstance` | (raw, recovered) → {ok} — **keyword/polarity only** | **YES (unrelated defect passes)** | **YES (defect-bearing→pass passes)** |
| 11 | Durable evidence | `orchestrator.ts:emitSemanticEvidence` → `worker.semantic` | verdict → receipt (no primary critic invocation id) | — | — |
| 12 | Fixer | `critic-fix-loop.ts:formatValidatedFixGoal` | `sv.blockingDefects` (validated) → fix goal | — | — |
| 13 | Duel | `semanticDuelEligible(sv.kind)` | fail/incomplete → duel-eligible | — | — |
| 14 | Promotion | `semanticPromotionEligible` in `promoteCandidate` | only `pass` promotes | — | — |

Strategies + their candidate binding (all route through the same critic/parse/recovery): normal + duel-primary +
duel-peer (`candidateId = task.taskId`), tournament + competitive (`candidateId = workspace.id`), fixer re-critique,
escalation re-critique, legacy/experimental completion. `verdictBindsCandidate()` had no production caller.
Escalation-consult: raw provider call OUTSIDE the ledger; cost folded via `recordExternal` but the invocation id
was DISCARDED and model/provider not captured — the `worker.escalation.consult` receipt had no linkage.

## The fix

### Allowed evidence-ID contract (`semantic-evidence.ts`, new)
`buildEvidencePackage(input)` enumerates a finite `EvidencePackage` from the SAME inputs the critic is shown:
`candidate`, `tree`, `req:goal` or `req:N` (acceptance criteria), `file:<p>` / `diff:<p>` (changed files),
`check:<name>` / `test:<name>` (deterministic + executed-test), `runtime:<id>`, `api:*`, `exec:*`, `prior:*`.
`resolveEvidenceRef` canonicalizes a raw reference (bare path with `:line` suffix, bare check/test/runtime name)
to a package id, or `undefined`. The critic prompt (`evidenceManifestInstruction`) lists the allowed ids and
requires each defect to carry `evidenceIds[]` + `requirementId`.

### Defect validation rules (`semantic-verdict.ts`)
When a package is present (production), each blocking defect must pass `validateDefectEvidence`: cite ≥1
RESOLVABLE evidence id AND a requirement resolving to the goal / a named acceptance criterion. Invalid defects
are dropped; a `fail` with no surviving defect → `indeterminate`; an `incomplete` with no valid missing
requirement → `indeterminate`; legacy `issues[]` (no evidence) → dropped. A `pass` that lists ANY concrete
blocking CLAIM (raw, pre-validation) is contradictory → `indeterminate` (fail-closed on self-inconsistency).
`BlockingDefect` gains additive `evidenceIds?` + `requirementId?`. **Backward compatible**: with NO package
(the parser's unit tests, injected critics) the Phase 4/9 behavior is byte-unchanged.

### Pre-recovery fingerprint + deterministic equivalence (`semantic-evidence.ts`)
`substanceFingerprint(raw)` captures — inference-free, from explicitly-present fields only — verdict polarity,
candidate/tree, per-defect {canonical claim, sorted evidence refs, requirement, severity, repairability},
missing requirements, advisories. `substanceEquivalent(fingerprint, recovered)` proves EXACT equality: same
polarity (no flip), same candidate/tree, same defect claim SET (no add/drop/reword), per-claim same evidence-id
set + requirement + severity + repairability, same missing-requirement + advisory sets, no advisory→blocker
promotion. `canonicalText` normalizes only whitespace/case/surrounding-punctuation — never fuzzy similarity.
A recovered `indeterminate` always preserves. Any mismatch ⇒ rejected ⇒ `indeterminate`.

### Recovery prompt (`critic-recovery.ts`)
`buildRecoveryRequest` now also binds the allowed evidence-id + requirement-id sets: the reformatter may KEEP
an evidence id already present, never introduce one.

### Critic wiring (`critic.ts`)
`CriticDeps.enforceEvidenceSubstance` (production `criticFor()` sets it true; injected/unit critics leave it
off). When on: build the package, thread it into the prompt + `SemanticParseContext`, capture the deterministic
fingerprint BEFORE the (structurally one-shot) recovery call, and validate recovery with `substanceEquivalent`
(the legacy keyword guard remains the non-enforcing path). Records `evidencePackageHash`, `substanceFingerprintHash`,
`recoveredOutputHash`, `equivalenceOk`, `equivalenceMismatches`.

### Durable semantic receipt (`orchestrator.ts:emitSemanticEvidence`)
`worker.semantic` now also carries `primaryCriticInvocationId` (from the ledger — "role"/"candidate-role" stage),
`evidenceEnforced`, `evidencePackageHash`, `substanceFingerprintHash`, `recoveredOutputHash`, `recoveryEquivalence`
+ `recoveryEquivalenceMismatches`, and `fixerEligible` (alongside the existing promotion/duel eligibility).

### Escalation-consult receipt closure (preflight; `invocation-ledger.ts` + `orchestrator.ts`)
`recordExternal` now captures `resolvedModel`/`provider`/`usage` and takes a `deferBudget` option (+ public
`applyBudget()`); `makeCostingEngine.addCost(usd, meta)` returns the invocation id. The consult site records the
external invocation with its execution identity, and the `worker.escalation.consult` receipt DERIVES
`invocationId` / `servedModel` / `provider` / `lifecycle` / `consultCostStatus` from that record. No consult
dispatch ⇒ no execution claim; a dispatched-but-unrecordable consult ⇒ `worker.escalation.consult.integrity_error`.
The budget cap is enforced AFTER the receipt is durable (Gap B/A2 preserved). **After this, every receipt that
claims provider execution references an invocation record.**

## Preserved invariants (unchanged)
Promotion authority (executed-test evidence, tree/CAS fail-closed, `promoteCandidate()` sole authority, manual
`/apply` still manual-unverified, post-promotion trust); invocation authority (every request ledgered, lane
enforcement, critic vs recovery separately ledgered); semantic authority (concrete blockers for fail, concrete
missing requirements for incomplete, malformed/generic/stale/unsupported → indeterminate, infra ≠ defect,
parser/recovery failure never triggers fixer/duel); repair authority (fixer gets validated defects only, fresh
evidence per repaired candidate, lane-pure); runtime truth advisory-only; `SafetyAssessment` non-authoritative.

## Files changed
- **new** `src/modules/worker-model/semantic-evidence.ts` — package, fingerprint, equivalence, validation.
- `semantic-verdict.ts` — package-gated defect/requirement validation; raw-claim pass-contradiction; additive fields.
- `critic.ts` — evidence package build + prompt manifest + strict recovery + provenance detail.
- `critic-recovery.ts` — allowed-evidence binding in the reformat request.
- `orchestrator.ts` — `criticFor` enforces; `worker.semantic` enrichment; escalation-consult linkage; `addCost`.
- `invocation-ledger.ts` — `recordExternal` execution identity + `deferBudget`/`applyBudget`.
- **new** `src/modules/worker-model/phase12-semantic-substance-conformance.test.ts` — 45 tests.
- `semantic-contract-conformance.test.ts` — ONE fixture updated (see below).

### Test changed (contract genuinely, intentionally changed)
`semantic-contract-conformance.test.ts` "2b: a real concrete-defect FAIL DOES make the attempt duel-eligible":
its critic output was a legacy `issues:[…]` string with NO evidence. Under Phase 12 a concrete fail must cite
resolvable evidence, so the fixture now uses a rich `blockingDefects` entry citing `file:a.ts` + `req:goal`. The
test's INTENT (a concrete fail is duel-eligible) is unchanged. The sibling "contradictory pass withheld" test
needed NO change — the pass-contradiction now keys on the RAW claim, so an unsupported-but-listed blocker still
fail-closes the pass.

## Tests added — 45 (all green)
- **A1–A8** evidence binding: package enumeration; supplied-evidence accepted; no-evidence / unknown-id / test-not-run /
  off-goal-requirement / cross-candidate / stale-tree → invalid.
- **B9–B29** equivalence: wrapper + whitespace reformats preserved; count±, add/drop/reword defect, add/remove
  evidence id, requirement change, advisory↔blocker, severity, repairability, pass↔fail, incomplete→pass,
  candidate/tree binding change, defect-bearing→pass, pass-like→fail all fail.
- **C30–C37** unsupported/eligibility: unsupported structured fail → indeterminate (no recovery); generic; invented
  test; empty / bare-FAIL / truncation / content-filter ineligible; binding mismatch not recovered.
- **D38–D49** seam (real enforcing critic + orchestrator): exactly one recovery; in-lane + ledgered + costed +
  receipt-linked; failed equivalence blocks fixer + duel + promotion and persists NO defect; structure-only
  recovery adopted; primary critic invocation id + provenance on the receipt; distinct semantic ids; production
  enforcement (unsupported fail → indeterminate).
- **E50** escalation-consult receipt references its invocation + derives execution identity.

## Mutation guards — 13, each demonstrated FAIL → revert
| # | Mutation | Guard | Result |
|---|---|---|---|
| 1 | recovery adds a defect (drop count+added checks) | B13 | fail→revert→pass |
| 2 | recovery drops a defect (drop count+dropped checks) | B14 | fail→revert→pass |
| 3 | recovery flips fail→pass (drop flip check) | B24 | fail→revert→pass |
| 4 | recovery flips pass→fail (drop flip check) | B23 | fail→revert→pass |
| 5 | recovery adds an evidence id (drop evidence-added) | B16 | fail→revert→pass |
| 6 | unsupported JSON accepted (force `validateDefectEvidence` valid) | A3 | fail→revert→pass |
| 7 | fuzzy wording accepted (truncate `canonicalText`) | B15 | fail→revert→pass |
| 8+9 | equivalence-always-ok ⇒ mismatch triggers fixer + duel | D42 | fail→revert→pass |
| 10 | a second recovery call | D38 | fail→revert→pass |
| 11 | recovery bypasses the ledger (wrong stage tag) | D39 | fail→revert→pass |
| 12 | receipt fabricates the primary critic invocation id | D46 | fail→revert→pass |
| 13 | escalation-consult receipt omits its invocation id | E50 | fail→revert→pass |

## Commands + results
- `pnpm build` — clean (tsc strict; typechecks `*.test.ts`).
- Phase 12 suite (tsx): **45 / 45**.
- Backward-compat suites (semantic-contract / critic-recovery / critic / critic-fix-loop): **78 / 78**.
- All worker-model tests: **1253 / 1253** (was 1208 → +45; the pre-existing `worker-model.cli.test.ts`
  "gate-denied promote" is env-sensitive to a stray `.env` sourcing — it fails identically with all Phase 12
  changes STASHED, and passes under the canonical `pnpm test` env; a sandbox anomaly, not an assertion regression).
- Production-config probe (`orchestrator.test.ts`, isolation=none, `.env`): **111 / 111** (unchanged).
- Full `pnpm test`: **3710 tests, 3709 pass, 0 fail, 1 skipped** (was 3665 → +45).
- No paid provider calls (all providers are test doubles).

## Answers to the phase's audit questions
- **Can recovery still invent or erase decision-bearing substance?** No — an enforcing critic accepts recovery
  only on proven deterministic substance equivalence; any add/drop/reword/re-evidence/re-scope/flip → indeterminate.
- **Can unsupported structured criticism become a defect?** No — a defect must cite resolvable evidence; unsupported
  claims are dropped and a fail with no surviving defect is indeterminate.
- **Can defect-bearing output become pass?** No — fingerprint blocking-polarity vs recovered pass is a flip.
- **Is every recovery call ledgered and lane-bound?** Yes — recovery dispatches through the run engine at stage
  "structured-recovery" on the SAME critic model; its receipt references that invocation (Phase 11C + guard D39).
- **Is Phase 11 now fully confirmed?** Yes for the execution-receipt boundary: with the consult closure, every
  receipt that claims provider execution references an invocation record.
- **Are Phases 1–11C intact?** Yes — all their conformance suites + the 111/111 probe are green; the only test
  edit is the documented 2b fixture (contract genuinely changed).

## Remaining semantic ambiguities / not globally fixed
- **Requirement resolution without explicit acceptance criteria** is coarse: when a task supplies no criteria, the
  whole goal is the single requirement anchor and any non-empty requirement resolves to `req:goal`. Off-goal
  requirement rejection is only sharp when a task supplies enumerated `acceptanceCriteria` (tests exercise both).
- **Enforcement is production-gated** via `enforceEvidenceSubstance` (set by `criticFor()`), so a caller that
  constructs `createCritic` without it (unit primitives) keeps the Phase 9 behavior by design. No production path
  omits it.
- **`worker.semantic` provenance is bounded** (hashes + the primary critic invocation id), not the raw evidence
  package inline — sufficient to reconcile, deliberately not a full dump.
- No remaining execution receipts lack invocation linkage (the consult exception is closed).

## Explicitly NOT changed (scope)
Model routing, roster semantics, attempt/lane policy, invocation-ledger accounting, Phase 10 promotion policy,
executed-test requirements, manual `/apply`, fixer architecture, runtime-truth authority, SafetyLedger, CLI cost
aggregation, Abina. No push / tag / PR / release. No broad cleanup (a speculative unused ledger helper from an
earlier phase was already removed; this phase adds no dead code).

## Commit
One cohesive commit (the evidence-binding + fingerprint + equivalence primitives and their receipt/consult
integration are interdependent and share the test suite; a single reviewable commit keeps every commit green):
`fix(critic): substance-preserving recovery + evidence-bound semantic decisions`. Not pushed.
