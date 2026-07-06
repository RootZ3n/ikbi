# Value-dimension ablation — drift-prevention

The 4th proving-ground dimension: reachability proved drift **executes**; this measures whether
it **matters** — *would the outcome change if drift-prevention didn't exist?*

**Method.** Drift's only causal path to any outcome is a text note it appends to the cognition
deliberation prompt (`cognition.ts` → `driftNote`). So we ablate at that seam. Reproduce:
`node scripts/proving-ground/ablate-drift.mjs` (real model calls; `ABLATE_N` samples per arm).

## Part A — realistic value (the state real builds run in)

`drift.check()` against a fresh/greenfield state returns **0 reports** → the note is **empty** →
**drift's influence on a real build is provably zero.** drift needs a durable `pattern` baseline
(success/failure history per operation) that a greenfield build never has, so `check()` finds
nothing to compare and emits nothing. This is why the receipt-only audit saw zero drift receipts,
and it holds for every build we've run.

## Part B — best-case value (drift at maximal signal, N=8 deliberations/arm)

Inject drift's strongest possible report (build reliability 30% vs 90% baseline, `major`) as the
ON arm; empty (== drift removed) as OFF. Same goal, model (mimo-v2.5 @ 0.2), empty memory.

| arm | recommendedNext.module distribution | avg confidence |
| --- | --- | --- |
| **OFF** (ablated) | batch-planner ×5, drift-prevention ×3 | 0.831 |
| **ON** (max signal) | drift-prevention ×8 | 0.844 |

**The decision changed:** the note moved the recommended module from a mix (mostly batch-planner,
37.5% drift) to **unanimously drift-prevention (100%)**. Confidence barely moved (+0.013).

## Verdict

- **Realistic value ≈ 0.** In every state a real build actually runs in, drift emits an empty note
  and changes nothing. drift ran on ~100% of cognition-invoking builds and changed the outcome on
  **0%** of them.
- **Best-case value is real but modest and somewhat circular.** Given a maximal injected signal —
  which requires a baseline + recent-decline history greenfield builds never have — the note does
  flip the deliberation's recommendation, but toward recommending *drift-prevention itself*.

This quantifies the original instinct ("we got lucky without it"): drift-prevention is
**structurally inert on the real path**, not because it fails to execute, but because it is
reportOnly and baseline-starved. To earn its place it needs the first-class-governor rework — a
live baseline (persisted patterns) and an intervention policy beyond reportOnly. The graduated
no-progress governor (commit f7b386c) is the intra-build seed of that.

## Rework — persisted baseline (increment 1, landed)

The root cause of "realistic value ≈ 0" was mechanical: the `pattern` baseline drift reads was
**never written** — `projectFromReceipts` (the writer) was called nowhere in production, so
`check()` always found no baseline. Fixed:

1. **Cumulative, prune-proof baseline** — `projectFromReceipts` now MERGES success/failure counts
   into the existing `pattern` via a per-pattern high-water `lastSeq` (idempotent across
   re-projection) instead of overwriting from the current query window. The baseline is now the
   durable *established normal* that survives receipt pruning and can diverge from the recent
   window (`memory.ts`).
2. **Wired to build completion** — after every `ikbi build` (success or failure), the run's
   receipts are folded into the baseline (`worker-model/cli.ts`, `patternsOnly`, best-effort).
3. **End-to-end proof** — `drift-prevention/baseline-integration.test.ts`: with no baseline drift
   is silent (the old inert behavior); after projecting a reliable history then collapsing,
   `drift.check()` DETECTS the decline (baseline 1.0 vs recent 0.0, `major`).

So the value path is now WIRED on the write side: the baseline accumulates a real reference across
builds. Two honest caveats remain (do not overstate liveness): (1) the READ side — `drift.check()` — is
still consumed only by niche surfaces (`ikbi recover` and the `--headless` bare-goal cognition path,
labeled experimental), NOT on or after the build path, so a decline is only surfaced if an operator runs
those; (2) it is reportOnly by default (advisory). Turning detection into intervention on the build path
(warn/block, and calling `check()` where a build can act on it) is the next increment — until then the
baseline is real but the alarm nobody reads.
