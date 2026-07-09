# The Adjudication Core — first-class build-completion & promotion

**Status:** design approved for implementation (2026-07-09). Replaces the scattered promote/discard
decision with one authoritative, type-enforced core. Synthesized from two code audits + a Fable
architecture pass.

## The problem (why it keeps breaking)

ikbi's build pipeline (scout→builder→verifier→critic→integrator, in an isolated worktree, promote only
on verified-green) keeps **discarding correct, fully-green work** ("false RED"), and it has been patched
dozens of times (orchestrator.ts is dense with FIX-markers). Root cause, in one line: the pipeline
**conflates "did the builder follow protocol?" with "is the work good?"** and scatters the answer.

Two audits quantified it:

- **Decision half:** the promote/discard decision is spread across **~16 orchestrator branches + 7
  integrator sub-gates + 7 rescue mutators + a duplicated competitive path.** Worse, "verified-green work
  exists on disk" is *decoupled from* "was it committed," and commit is gated on **trust tier**
  (`autoCommit`, true only at `trusted`+). A correctness signal entangled with a trust decision. Every
  rescue path must independently remember to commit or its green result silently becomes an empty diff.
- **Truth half:** the verifier's green/red decision is fragile. Biggest hole: **zero flaky-test
  tolerance** — any failing test anywhere makes the whole build RED, even if the module under
  construction is perfect (ikbi's own suite has timer/random tests). Plus: the builder's in-loop
  `run_checks` triages only the **last 2000 chars** of output (verifier reads the full stream) → the
  builder is half-blind; the builder's checks are **never scoped** (runs the full ~3300-test suite every
  check); `parseTestCount` is an order-dependent regex zoo.

## The thesis

**The builder is a worker, not a witness.** Its exit status is evidence about *whether to keep spending
effort* — never evidence about *whether the work on disk is good*. The only witness to work-goodness is
the verifier running real checks on the actual tree; the only judge is a single decision function whose
input type **cannot express** a protocol exit.

## The core model — four strictly-separated facts

| Fact | Produced by | Consumed by |
|------|-------------|-------------|
| **WorkProduct** `{treeHash, diffStat, nonEmpty}` | **git** on the worktree (NOT the builder's `filesWritten` ledger) | EffortPolicy + DecisionCore |
| **ProtocolExit** `{kind: done\|stall\|hard_error\|aborted, stopReason, attempts}` | builder loop | EffortPolicy + trust ledger + receipts — **never DecisionCore** |
| **WorkAssessment** `{verdict, testEvidence, checks[], treeHash}` | verifier, on the final disk state | DecisionCore |
| **SafetyLedger** `{externalInjection, effectiveBreach, refuted, killed, driftBlocked, gateWallAuthorized}` | chokepoint / gate-wall / refuter / kill-switch (sticky per run) | DecisionCore |

Two load-bearing details: **WorkProduct comes from git, not the tool ledger** (ground truth), and
**WorkAssessment is bound to a tree hash** — a promote of any other tree with that verdict is a
type-level impossibility (closes the fixer TOCTOU window).

## The authoritative predicate (one function, one call site)

```ts
function decidePromotability(work, assessment, safety, critic): Decision
// ProtocolExit is NOT a parameter — enforced by the type system (invariant I4).

PROMOTE ⇔ work.nonEmpty ∧ assessment.verdict==="pass" ∧ assessment.testEvidence==="executed"
        ∧ assessment.treeHash === work.treeHash ∧ critic.pass
        ∧ ¬externalInjection ∧ ¬effectiveBreach ∧ ¬refuted ∧ ¬killed ∧ ¬driftBlocked
        ∧ gateWallAuthorized
```

Every existing fail-closed gate survives; the verdict gets **stronger** (tree-hash binding). Exactly one
term is **removed**: `builderOk`. **Retain is first-class**: green work a governance gate withholds is
*retained + reported "green-withheld"*, never discarded/laundered into "builder failed."

## Where protocol-status legitimately lives: the EffortPolicy

`ProtocolExit + WorkProduct + WorkAssessment?` → choose: `re-dispatch | escalate tier | run fixer | stop`,
bounded by one global attempt ceiling + budget. This absorbs today's four independent rescue branches
(guaranteed flash→pro escalation, last-mile fixer, critic-fix loop, fix-retry loop) as **strategies of
one policy**. Also closes the known gap ("fixer only fires on builder protocol-stop, not verifier-caught
red") by construction.

## Reserved adjudication budget

The verifier gets a reserved budget slice the builder **cannot consume**
(`builderBudget = total − reservedAdjudication`, reserve ≥ measured/estimated full-suite duration ×
safety factor). A builder timeout can therefore never starve verification of work already on disk. This
is the mechanism without which the false-RED merely relocates.

## Invariants (become permanent guard tests)

- **I1** Green work is never discarded (withheld ⇒ retain, not discard).
- **I2** No false green — promote ⇒ a verifier receipt with verdict=pass ∧ evidence=executed ∧
  `treeHash === promoted tree`. Any post-verify write forces re-verification.
- **I3** Work always gets its day in court — nonEmpty ∧ ¬killed ⇒ a verifier receipt for the final tree.
- **I4** Protocol-status cannot reach the verdict — `decidePromotability` has no stopReason field
  (type-enforced + a fuzz property test).
- **I5** Outcome ≡ decision — one total mapping; every reason from a closed enum.
- **I6** No vacuous pass — testEvidence≠executed ⇒ ¬promote (preserved verbatim).
- **I7** Safety vetoes are sticky & monotone; prevented attempts are warnings (judged by effect).
- **I8** Effort is bounded — one global attempt ceiling + budget deadline; every iteration receipted.
- **I9** Single decision point — exactly one production call site (guard test, phantom-integration style).

## Migration (4 mechanical steps, each independently green)

1. **Extract the facts** (no behavior change): the four types, `computeWorkProduct(workspace)` (git-based),
   stamp `treeHash` on the verifier result + `ProtocolExit` on receipts. New fields write-only.
2. **DecisionCore in shadow mode**: run `decidePromotability` alongside the old AND-gate on every run,
   emit a `worker.decision.divergence` receipt when new ≠ old. Validate against a dogfood campaign
   (ikbi/bokahli/osapa) + the proving-ground harness. Expected divergences = exactly the false-REDs.
3. **Rewire the control flow**: builder non-success → `computeWorkProduct` → verifier when nonEmpty; fold
   the special cases into EffortPolicy and **delete** them (auto-verify-rescue + RESCUABLE_TERMINATIONS
   allowlist, fixer-on-verifier-fail, silent-success-0-files branch, `builderOk`, guaranteed escalation,
   fix loops). Split the budget. Preserve: trust-suppression, skip-critic-on-red, injection chokepoint,
   refuter, gate-wall, dirty-repo refusal, step-planner skipVerifier.
4. **Flip and lock**: old path behind `IKBI_LEGACY_COMPLETION=true` for one release, then remove. Land
   the I1–I9 guard tests as permanent fixtures so the next edge-case cannot re-scatter the decision.

Also fold in the truth-half fixes: scope the builder's `run_checks` to the verifier's ladder set + give
it full stdout (not the 2000-char tail); run affected-test *targets* rather than the whole root suite in
the full stage; add a bounded, receipted, whole-check (never per-test) flaky re-run. Keep `testEvidence`
as the false-GREEN backstop throughout.

## Test matrix (abridged — see §5 of the design for all 25+)

- **Promote (false-RED class):** every builder exit × nonEmpty × green ⇒ promote (T1–T7, incl.
  self-hosting-huge-suite where the verifier runs on reserved budget after the builder is starved).
- **Fail-closed:** verifier-red, vacuous-green (zero/unverified evidence), no-work/empty-diff,
  unresolvable, external-injection, effective-breach, refuter, kill-mid-verify, gate-wall-withheld ⇒
  retain not discard, stale-verdict (treeHash mismatch) ⇒ re-verify (T8–T17).
- **Effort loop:** fix→re-verify, escalate, attempt-ceiling halt, flaky single-re-run (two reds ⇒ red,
  never selective ignore), critic-fail-exhausted ⇒ retain green (T18–T25).
- **Structural:** fuzz stopReason ⇒ decision invariant (I4); one decision receipt per terminal (I5);
  single call site (I9); git-vs-ledger divergence adjudicated on git truth; competitive per-candidate
  predicate (T-P1–T-P5).

## Key risk

More promotes ⇒ more false-GREEN surface. Guards that MUST stay in the predicate: tree-hash binding (I2),
testEvidence gate (I6), stub-script/zero-test/exit-swallow triage, **and the critic** (a flailing builder
can leave "green but not what was asked" — do not drop the critic for cost). Run the blast-radius /
no-test-drop meta-gate *inside* adjudication (on the tree the verifier judges), and add "test count did
not decrease vs. base" for repair-mode builds.
