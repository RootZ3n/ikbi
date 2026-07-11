# Handoff — Phase 4: Canonical Semantic-Evaluation Contract

Date: 2026-07-10
Branch: `harness/cc-parity-and-bokahli-pilot`
Base: Phase 1 `288ad62` → Phase 2 `4aba481` → Phase 3 `eb30554`
Scope: one truthful semantic-evaluation contract for every promotion-capable strategy. No model-router/
roster/vendor-lane/trust-math/runtime-truth/classifier-cost/cross-lane-fixer redesign; no new promotion
callers; the Phase 3 stale-tree checks and experimental-completion quarantine are preserved.

## Pre-change semantic-path inventory

| Path | Candidate | Critic invoked? (before) | Parser | Verdict → policy (before) | Defect persistence | Duel impact (before) | Production-reachable |
|---|---|---|---|---|---|---|---|
| Normal builder | single | yes (real critic) | parseStructuredVerdict → `detail.pass` | integrator AND-gate on `detail.pass` | receipt summary only | any non-success → `candidate-rejected` (duel) | yes (default) |
| Primary duel | single, deepseek lane | yes | same | same | same | critic FAIL / parse-fail / bare FAIL all → `candidate-rejected` (duel) | via `--tier cheap` |
| Peer duel | single, mimo lane | yes | same | same | same | same | on primary non-promotion |
| Tournament | shadow winner | **NO** | — | deterministic judge only; `semanticKind: not-evaluated` | none | n/a | flag `IKBI_CANDIDATE_MODELS` |
| Competitive | winner | **NO** | — | deterministic judge only; `not-evaluated` | none | n/a | flag `IKBI_WORKER_MODEL_COMPETITIVE` |
| Rescue/fixer | new revision | re-critique after fix | same | same | fix goal from `feedback`+`issues` | re-critique verdict | yes |
| Legacy completion | single | yes | same | integrator | receipt summary | same | default |
| Experimental completion (`=off`) | single | yes | same | adjudication (quarantined Phase 3) | — | same | exact `off` |
| Adjudication | single | reads critic `detail.pass` | — | `decidePromotability` | — | n/a | shadow default / flag |
| Critic retry / parser-repair | single | fix-loop re-critique | parseStructuredVerdict | `isRetryableCriticFail` (pass:false + !objectiveFailure) | — | retryable FAIL fires fix-loop/escalation | yes (opt-in `criticFixLoop`) |

Two structural problems this phase fixes: (1) a bare/unparsable/truncated critic FAIL was treated as a
retryable candidate rejection → it could trigger a peer duel and blocked promotion as if it were a real
defect; (2) tournament/competitive winners reached the Phase 3 promotion authority with `not-evaluated`.

## Old critic output contract

`{"verdict":"PASS|FAIL","scores":{...},"feedback":"...","issues":["..."]}` parsed by
`parseStructuredVerdict` into `{pass, feedback, scores?, issues?}`. A `{"verdict":"FAIL"}` with no issues
was accepted as `pass:false` with `feedback:"FAIL"`; a parser throw / truncation became a subjective
`pass:false`. `detail.pass` drove the integrator; nothing distinguished a concrete defect from a bare
rejection, an incomplete, an indeterminate parse, or an infrastructure failure.

## New canonical semantic verdict (`semantic-verdict.ts`)

`SemanticVerdict = { kind, summary, blockingDefects[], incompleteRequirements[], advisories[],
parseStatus, candidateId?, verifiedTree?, evaluatorModel?, retryCount? }` where
`kind ∈ { pass | fail | incomplete | indeterminate | infrastructure-failure | not-evaluated }` and a
`BlockingDefect = { id, claim, evidence, requirement, severity:"blocking", confidence, location?,
repairable? }`.

## Parser rules (`parseSemanticVerdict`, STRICT)

- `fail` requires ≥1 **concrete** blocking defect (rich `blockingDefects`, else legacy `issues`); zero → `indeterminate`.
- `incomplete` requires ≥1 concrete missing requirement; zero → `indeterminate`.
- `pass` must carry NO **rich** blocking defect (legacy `issues` on a PASS are advisories); a PASS-with-defect → `indeterminate`.
- a PASS whose `goal_correctness` score is below the threshold (mirrors `parseStructuredVerdict`) → `incomplete` (not a fabricated defect).
- unparsable / non-JSON / plain-text `FAIL` / missing-or-unknown verdict token → `indeterminate` (`parseStatus:"unparsable"`).
- a **generic** claim ("the implementation is wrong", "the code is bad") or a claim <8 chars is NOT concrete → dropped; a `fail` with only generic claims → `indeterminate`.
- never fabricates a defect; never turns indeterminate into fail; candidate/tree binding is stamped from context (`verdictBindsCandidate` rejects a verdict whose `candidateId`/`verifiedTree` mismatches).

## Concrete-defect requirement / incomplete-vs-fail

`fail` = a concrete, blocking, candidate-bound defect that a fixer can act on. `incomplete` = valid,
inspectable work that leaves a **named** goal requirement unmet (not a stylistic objection). Both are
non-promotable and duel-eligible (a different vendor may do better). A defect must bind to the current
candidate/tree — evidence from another candidate or a stale tree is invalid.

## Indeterminate / infrastructure-failure behavior

`indeterminate` = the output cannot support pass/fail (bare `FAIL`, contradiction, generic-only, missing
fields, unparsable). `infrastructure-failure` = the model call could not complete (truncation/
finishReason=length, content_filter, no-diff-source). **Neither is a defect, neither is autonomously
promotable, and neither is duel-eligible** — a peer vendor cannot fix an unparsable critic or a provider
outage. Both still fail-closed on promotion (`detail.pass:false` unchanged).

## Retry policy

Unchanged from prior phases and documented explicitly: the opt-in critic-fix loop
(`isRetryableCriticFail` = `outcome:"success" + pass:false + !objectiveFailure`) gives ONE bounded
builder-repair pass on a critic FAIL, then re-verifies + re-critiques; the escalation ladder gives one
bounded model swap. **No NEW critic retry / parser-reformat call was added** in this phase (avoiding new
cost + new failure modes); a bounded structured-output reformat retry is a documented follow-up. The
existing retries never change the vendor lane (Phase 2), never alter attempt identity, and — now — an
indeterminate/infrastructure critic can no longer masquerade as a candidate rejection to spawn a peer
duel (proven by the conformance tests).

## Deterministic-evidence relationship

Unchanged and preserved: the verifier runs BEFORE the critic and its objective verdict + checks + the
diff summary + builder summary/detail are fed to the critic as untrusted DATA. The semantic verdict and
the deterministic verdict remain **separate evidence types**; the critic does not re-litigate objective
checks and cannot invent deterministic success. The canonical promotion authority still requires a green
verifier (Phase 3) AND a semantic pass (Phase 4).

## Path-by-path: before → after

- **Normal / duel** — the critic now ALSO stamps `detail.semanticVerdict` (the canonical parse of the
  SAME response); `detail.pass` is unchanged (the integrator + fix-loop read it). `classifySemanticVerdict`
  reads the stamped verdict. An INDETERMINATE or INFRASTRUCTURE critic now classifies the terminal as a
  new `nonPromotion.class: "semantic-indeterminate"` (`duelEligible:false`) — it is no longer a
  duel-eligible `candidate-rejected`. A concrete `fail`/`incomplete` stays `candidate-rejected` (duel).
- **Tournament / competitive** — **now run the canonical critic on the selected winner** (a role dispatch
  on the shadow / winner workspace) before submitting to the promotion authority. Their promotion evidence
  carries the real `semanticKind` (never `not-evaluated`). Ranking still selects; it no longer substitutes
  for semantic evaluation.
- **Fixer** — unchanged: the fix goal is built from `feedback`+`issues` (authentic critic output), and
  after the fix the candidate is re-verified AND re-critiqued (fresh semantic evaluation against the new
  tree). Pre-fix verification never authorizes post-fix promotion (Phase 3 stale-tree + fresh re-critique).
- **Adjudication / legacy / experimental** — behavior preserved; the Phase 3 quarantine of
  `IKBI_LEGACY_COMPLETION=off` is intact. Adjudication still reads `detail.pass`; it cannot manufacture a
  verdict.

## Promotion-policy mapping (canonical authority, Phase 4 gate)

`promoteCandidate` now consumes `evidence.semanticKind`: `pass` → eligible; `fail`/`incomplete`/
`indeterminate`/`infrastructure-failure` → **withheld** (records `worker.promotion.semantic_withheld`);
`not-evaluated` → withheld unless `evidence.semanticEvaluationOptional === true`. This is what stops a
tournament/competitive winner (or a contradictory integrator-approved-but-not-pass verdict) from promoting
under uncertainty. On the normal path the integrator already gates on `detail.pass`, so this is
defense-in-depth there and load-bearing for the flag-gated strategies.

## Receipt / evidence changes

- The critic stamps `detail.semanticVerdict` (full structured verdict incl. `evaluatorModel`, defects,
  advisories, `parseStatus`) on its role result.
- The `worker.promotion` receipt already carries `semanticVerdict` (the KIND); a new
  `worker.promotion.semantic_withheld` receipt records a semantic refusal (candidate/attempt/strategy/
  kind/optional-flag).
- **Remaining gap (documented):** the promotion receipt records the semantic KIND, not the full
  blocking-defect list — the full verdict lives on the critic role result, not in a durable dedicated
  semantic receipt. Persisting the full structured verdict in a `worker.semantic` receipt is a follow-up.

## Files changed

- `src/modules/worker-model/semantic-verdict.ts` — **new**: types + `parseSemanticVerdict` +
  `infrastructureFailureVerdict` + `notEvaluatedVerdict` + `verdictBindsCandidate` +
  `semanticPromotionEligible` + `semanticDuelEligible`.
- `src/modules/worker-model/critic.ts` — stamp `detail.semanticVerdict` on every return path;
  parse-fail / truncation / content_filter / no-diff-source classified as indeterminate vs infrastructure.
- `src/modules/worker-model/contract.ts` — `NonPromotionClass += "semantic-indeterminate"`.
- `src/modules/worker-model/orchestrator.ts` — `classifySemanticVerdict` reads the stamped verdict
  (kind `concrete-fail`→`fail`); the terminal duel classification treats indeterminate/infra as
  non-duel; the canonical authority's semantic promotion gate; tournament + competitive dispatch the
  critic on the winner; `CandidateEvidence.semanticEvaluationOptional`.
- Test updates (realistic critic verdicts, now that the critic gates promotion): `orchestrator.test.ts`,
  `competitive.test.ts`, `tournament.test.ts`, `model-identity-conformance.test.ts`,
  `lane-duel-conformance.test.ts`, `promotion-funnel-conformance.test.ts`.
- `src/modules/worker-model/semantic-contract-conformance.test.ts` — **new** (19 tests).

## Tests added / mutation evidence

19 conformance tests: strict parser (pass/fail/incomplete/indeterminate; bare FAIL, malformed,
contradiction, generic-claim, advisories-on-pass, missing-requirement — reqs 1-9); candidate/stale-tree
binding (reqs 10, 11); kind + policy helpers; evaluator-model on the verdict (req 23); and real-seam:
a real PASS promotes, a contradictory integrator-approved verdict is semantically WITHHELD (no promote),
an indeterminate (bare FAIL) and an infrastructure (unparsable) critic are NOT duel-eligible (reqs 20,
21), and a concrete-defect FAIL IS duel-eligible.

Mutation evidence (reverted before commit):
- fabricate a defect from a bare/generic FAIL → parser tests 3 + 7 fail. [mutations 1, 6]
- make indeterminate/infrastructure duel-eligible → seam tests 20 + 21 fail. [mutation 5]
- reuse a verdict across candidates / a stale tree → binding tests 10 + 11 fail. [mutations 3, 4]
- (mutation 2, tournament winner promotes as `not-evaluated`) → the semantic gate refuses `not-evaluated`;
  removing it lets the winner promote unevaluated, which the tournament/competitive semantic dispatch +
  gate now prevent.

## Commands and exact results

```
pnpm build                 # clean (tsc strict, typechecks tests)
# focused: semantic-contract-conformance, critic, critic-fix-loop, orchestrator, tournament,
#          competitive, promotion-funnel-conformance, model-identity-conformance, lane-duel-conformance
pnpm test                  # full suite
```

- `pnpm build`: **passed**.
- `semantic-contract-conformance.test.ts`: **19 / 19** (fails under the mutations above).
- Phase 1 `model-identity-conformance`: **6 / 6**; Phase 2 `lane-duel-conformance`: **16 / 16**; Phase 3
  `promotion-funnel-conformance`: **10 / 10**; `critic.test.ts` + `critic-fix-loop.test.ts`: green;
  `orchestrator` / `tournament` / `competitive`: green.
- `pnpm test` (full): **tests 3532, pass 3531, fail 0, skipped 1**. Baseline after Phase 3 was
  3513/3512/0/1; the delta is exactly the +19 new tests. No pre-existing failures; none introduced.

## Commit

ONE cohesive implementation commit (the parser, the critic emission, and the orchestrator integration
are interdependent and the orchestrator.ts hunks cannot be cleanly split without interactive staging).
Subject: `fix(critic): require concrete candidate-bound defects; unify semantic evaluation`. Per the
Phase 1-3 convention this handoff is included in the same commit. Resolve the SHA with
`git log -1 --format=%H`. Not pushed, tagged, or opened as a PR.

## Remaining semantic bypasses / not globally fixed

- **`not-evaluated` remaining uses:** it is emitted only by `classifySemanticVerdict(undefined)` — i.e.
  when NO critic role ran (a `skipCritic` intermediate step, which never promotes; or a promotion-capable
  path with no critic, which the authority now REFUSES). No promotion-capable strategy submits
  `not-evaluated` and promotes by default. `semanticEvaluationOptional` exists but no code path sets it.
- **Full-defect persistence:** the promotion receipt records the semantic KIND, not the full blocking
  defects (they live on the critic role result). A dedicated durable semantic receipt is a follow-up.
- **No new bounded parser-reformat retry** was added (documented above) — an indeterminate critic
  fail-closes rather than triggering a reformat retry.
- **Cross-lane fixer (IKBI-RT-012):** unchanged — the fixer model is still not lane-filtered. Its
  candidate/evidence are truthful (it re-verifies + re-critiques), but lane purity is not global.

## Status of the audit findings

- **IKBI-RT-004** — FURTHER closed. Tournament/competitive now run the canonical critic on the winner and
  submit a real semantic verdict to the single promotion authority; they can no longer promote as
  `not-evaluated`. The promote authority AND the semantic contract are now uniform across strategies.
- **Unexplained-FAIL audit finding (IKBI-RT-006 core)** — ADDRESSED at the contract level: a bare or
  unparsable `FAIL` is `indeterminate`, never a fabricated concrete defect; a `fail` requires ≥1 concrete
  candidate-bound defect; the receipt records the truthful kind. (The full critic prompt/retry redesign
  remains a dedicated later phase, as the brief directs.)
- **IKBI-RT-012** — OPEN (out of scope).

## Confirmation of prior invariants

- **Phase 1** (rented == dispatched == billed == receipt): `model-identity-conformance` 6/6 green.
- **Phase 2** (one lane/attempt, distinct primary/peer identity, duel only on candidate rejection, zero
  peer cost after promotion, no hidden cross-lane fallback): `lane-duel-conformance` 16/16 green; and
  Phase 4 makes duel eligibility MORE precise (indeterminate/infra no longer duel).
- **Phase 3** (`promoteCandidate` sole promote caller, verified==promoted tree, stale-tree binding,
  post-promotion trust, quarantine, bare/unparsable FAIL is indeterminate): `promotion-funnel-conformance`
  10/10 green; the quarantine and stale-tree checks are untouched.

## Diff hygiene

The diff touches only `semantic-verdict.ts` (new), `critic.ts`, `contract.ts`, `orchestrator.ts`, the two
new/updated conformance test files, and the prior-phase test files whose critic doubles needed realistic
verdicts now that the critic gates promotion. No unrelated cleanup.
