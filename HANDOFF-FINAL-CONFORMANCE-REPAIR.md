# HANDOFF — Final Conformance Repair Sprint (IKBI-RUNTIME-CONFORMANCE-REAUDIT-3)

**Honest status: this pass safely closed the surgical, regression-safe subset of the 17 findings and documents
the remainder with the exact reason each could not land without breaking the green suite / production probe or
destroying verified work.** No finding was marked fixed that is not test-backed. Nothing was pushed/tagged/PR'd.

- **Fully fixed (2):** `IKBI-REAUDIT3-005` (style-category laundering), `IKBI-REAUDIT3-013` (typed test evidence).
- **Partially fixed (2):** `IKBI-REAUDIT3-006` (recovery drift), `IKBI-REAUDIT3-017` (snapshot cleanup on throw).
- **Open (13):** 001, 002, 003, 004, 007, 008, 009, 010, 011, 012, 014, 015, 016.

## 1. Verified starting state

- Branch `harness/cc-parity-and-bokahli-pilot`; HEAD at start `19a2c75`; 227 ahead of `origin/main`; tracked
  tree clean. Pre-existing untracked reports/handoffs untouched (audit/reaudit/reaudit-2/reaudit-3, the two
  consolidated handoffs, `ikbi-0.1.0-rc.1.tgz`, `.claude/`, `scripts/ui-verify/package-lock.json`).
- Sprint HEAD `c06fe94` (2 new commits); **229 ahead of `origin/main`**; tracked tree clean.

## 2. Subagent inventories (start-of-sprint, read-only)

Reconciled quickly (not re-audited): the REAUDIT-3 report itself is the authoritative finding inventory (9
REAUDIT2 dispositions + 17 new REAUDIT3 findings, with file:symbol source evidence and reproductions per
finding). Two prior-session code-tracers already confirmed (in `HANDOFF-PHASE-13-15-CONSOLIDATED.md`) that:
promotion lands via git ref (not snapshot file copy); tests run in the mutable workspace; leases gate only the
`applyDiff` seam; composite is production-wired only for the duel; the ledger wrapper (not frozen-core route) is
the journal seam. Those confirmations match REAUDIT-3's independent findings, so the sprint proceeded directly
to implementation rather than re-inventorying.

## 3. Finding-by-finding disposition (001–017)

See `FINAL-CONFORMANCE-FINDINGS.json` for the machine-readable matrix (id / severity / status / commit / source
files / retained tests / remaining limitation). Narrative:

| # | Sev | Status | What landed / why not |
|---|---|---|---|
| 001 | Critical | open | Freeze-before-verify pipeline reorder + mandatory snapshot for every git-backed autonomous strategy + production lease wiring + snapshot-into-promote. Cannot land without breaking the production probe (non-existent fake paths) and every strategy test. Phase 13 fence + stale-tree + CAS + normal physical snapshot remain. |
| 002 | High | open | Per-route pre-dispatch provider journal lives in FROZEN CORE `invoke.ts`; frozen-core + high blast radius. |
| 003 | High | open | Known-subtotal retention + `executedIds` include-failed + production parent ledger for all strategies. Touches tested ledger accounting; deferred. Duel composite remains the only wired composite. |
| 004 | High | open | Immutable invocation/evaluation objects + pre-append reconciler; large cross-cutting change. |
| 005 | High | **fixed** | `c06fe94` — a deterministic style-claim detector routes any style/formatting/naming/architecture-preference claim through the explicit-style-policy rule (named criterion OR failed formatter), regardless of declared/omitted/mislabeled category. 4 retained tests. |
| 006 | High | **partial** | `c06fe94` — recovery now rejects category REMOVAL and UNKNOWN/INDETERMINATE→BLOCKING polarity. `req:goal`-add + free-text-requirement remain accepted (documented; req:goal is contextual and authorizes no blocker alone). 3 retained tests. |
| 007 | Medium | open | Gate authority as a required field of every strategy result + trust-reducer suppression in competitive/tournament; deferred to avoid strategy-trust-test blast radius. Normal mode already suppresses + labels. |
| 008 | Medium | open | **Implemented then reverted** — the existing-accessible-dir-only classification made the production probe's non-existent fake paths indeterminate, breaking 58 tests incl. the 111/111 probe. One-regex fix that needs the in-memory-workspace test corpus migrated to real dirs. |
| 009 | High | open | Typed internal shadow-replay capability outside model-command policy. Not attempted; tournament autonomous mode is effectively quarantined until it lands (documented). |
| 010 | Medium | open | Mandatory immutable runtime scope tuple + fresh-package-after-mutation. Runtime truth remains advisory. |
| 011 | Medium | open | Typed immutable multi-step handoff (replaces `completedSteps` labels). |
| 012 | Medium | open | Final whole-diff protected-path rescan before freeze/promotion. |
| 013 | Medium | **fixed** | `693ddde` — `readVerifier` recognizes executed-test evidence by typed check `kind` (unit/integration/repository/executed-test) + typecheck by kind, not only display name "test". Backward compatible. 4 retained tests. (Verifier does not yet STAMP typed kinds by default — reader honors them when present.) |
| 014 | Low | open | Distinguish verified-workspace-success from governed-landed-success — a core trust-schema change; ladder off by default. |
| 015 | Low | open | Manual authority class into the core promote receipt + surface secondary-receipt failure. Manual receipt already carries `authorityMode:"manual-unverified"` (secondary/best-effort). |
| 016 | Medium | open | **Implemented then reverted** — `isRetryableCriticFail → effectiveDecisionKind` broke ~30 injected-critic doubles that stamp a no-`evidenceEnforced` fail and rely on the fixer. Duel/promotion ALREADY downgrade a no-package fail; only the fix-loop trigger uses raw kind. Needs the injected-critic double corpus migrated to carry `evidenceEnforced`. |
| 017 | Medium | **partial** | `693ddde` — a throw from `promoteCandidate` after a real snapshot now cleans the detached worktree + surfaces `worker.promotion.snapshot_cleanup_incomplete`. Full try/finally over every receipt terminal is the residual. |

## 4. Files changed

- `src/modules/worker-model/orchestrator.ts` — `readVerifier` typed check-kind recognition + `TEST_CHECK_KINDS`
  (013); guarded snapshot cleanup on `promoteCandidate` throw (017).
- `src/modules/worker-model/semantic-evidence.ts` — `STYLE_CLAIM_RE`/`isStyleClaim` style-claim routing in
  `validateDefectEvidence` (005); `category-removed` + `unknown-polarity-recovered-to-blocking` equivalence
  rejections (006).
- **new** `src/modules/worker-model/phase16-final-sprint-conformance.test.ts` — 12 retained regressions
  (WS1/013 x4, WS2/005 x4, WS2/006 x3, WS2/016-partial x1).

No production configuration, existing handoff, or pre-existing untracked artifact was modified. The two reverted
findings (008, 016) left the code and their incidental test-fixture touches back at their original state.

## 5. Architecture changes

Minimal and additive. No pipeline reorder, no frozen-core change, no trust-schema change, no new parent ledger.
The style-claim detector and typed-check-kind recognition are additive validators; the equivalence tightenings
add mismatch reasons; the snapshot cleanup guard wraps one call site. No public contract changed.

## 6. Production paths covered by the landed fixes

- `readVerifier` (013) is the single production reader every strategy uses for test evidence
  (normal/duel/fixer/escalation/competitive/tournament all call it) — the typed-kind recognition applies to all.
- `validateDefectEvidence` (005) is the production defect gate for every enforcing critic
  (normal/duel/fixer/escalation/tournament/competitive).
- `substanceEquivalent` (006) is the production recovery-equivalence gate for every enforcing critic.
- The snapshot cleanup guard (017) is on the normal-mode git-backed autonomous promotion path.

## 7. Tests added + commands/results

- **New:** `phase16-final-sprint-conformance.test.ts` — **12/12**.
- `pnpm build` — clean (`tsc -p tsconfig.json`, strict; exit 0).
- Full `pnpm test` — **3851 tests, 3850 pass, 0 fail, 1 skipped** (was 3839 → +12).
- Production-config probe (`orchestrator.test.ts`, `.env`, `IKBI_GATE_WALL_BYPASS=false`) — **111/111**.
- Semantic + snapshot + promotion + builder suites — green within the full suite.
- No paid-provider calls, no external network.
- **Reverted-implementation evidence:** the full suite was run WITH 008+016 applied → **58 failures** (008 broke
  the production probe's non-existent fake paths → identity-indeterminate; 016 broke injected-critic fixer
  doubles). After reverting those two, the suite returned to **3850/0/1**. This is the concrete proof that 008
  and 016 cannot land safely without the documented test-corpus migrations.

## 8. Commit hashes

- `693ddde` — `fix(authority): typed test evidence + guarded snapshot cleanup` (013, 017 partial).
- `c06fe94` — `fix(semantic): close style-category laundering + recovery drift` (005, 006 partial) + the retained suite.

Two commits (the 4-commit plan's WS3/WS4 did not produce safely-landable changes). Not pushed.

## 9. Operational defaults + warnings

- **The active untracked `.env` still sets `IKBI_GATE_WALL_BYPASS=true`** (lab-only operator convenience). It was
  NOT staged or modified. **Operational warning:** a governed autonomous profile MUST set `IKBI_GATE_WALL_BYPASS=false`;
  the production probe is run with it false. Canonical promotion receipts already label an administratively-bypassed
  land truthfully (Phase 13), but competitive/tournament trust suppression parity (007) is NOT closed.
- No secrets were read from or written to `.env`.

## 10. Direct answers to the required handoff questions

- **Do tests / semantic / gate / CAS / promotion use one immutable snapshot?** **No, not universally** — tests
  still run in the mutable workspace; the physical snapshot (normal mode only) is an integrity witness bound by
  identity + CAS, not the tested subject; competitive/tournament create no physical snapshot. (001 open.)
- **Does every provider dispatch have a pre-dispatch provider-attempt row?** **No** — one logical row is
  pre-dispatch; per-provider rows are post-terminal; classifier/consult are post-facto. (002 open.)
- **Does every execution receipt mechanically reconcile?** **No** — synthetic classifier IDs,
  `lastFor`/`singleBuilderModel` fallbacks, consult reconstructed identity, and `executedIds` omitting failed
  records remain. (004 open.)
- **Does every composite include losing/failed work?** **Only the conditional duel** is production-wired;
  tournament/multi-step/competitive/CLI-cognition composites are module-supported only. (003 open.)
- **Can unsupported criticism trigger fixer or duel?** **Duel: no** (already fail-closed). **Fixer: still yes on
  the injected/non-enforcing compatibility seam** (016 open); the default production critic always enforces, so
  the default path is safe. A STYLE preference can no longer trigger either via category laundering (005 fixed).
- **Does every strategy propagate bypass authority + trust suppression?** **No** — normal mode does;
  competitive/tournament do not. (007 open.)
- **Does tournament work through its production replay path?** **No** — production `defaultApplyDiff` sends
  `git apply` through the model-command policy that denies it; tournament autonomous replay is effectively
  quarantined until 009 lands.
- **Does multi-step use a typed evidence handoff?** **No** — still `completedSteps` labels. (011 open.)
- **Are all 17 findings closed?** **No.** 2 fixed, 2 partial, 13 open — enumerated above with rationale.

## 11. Remaining live-provider + platform uncertainties

Unchanged from prior handoffs: no live/paid provider called (served identity, SDK-internal retries, billing,
cancellation vs a real provider **not verified**); POSIX-only snapshot read-only enforcement; abort not
propagated to provider/governed-child; process-crash provider-journal durability is in-memory. Lab-only,
single-trusted-operator boundary preserved (no SaaS/WAF/auth/tenant work added).

## 12. Explicit statement of what is NOT globally fixed

The Critical global invariant (**one immutable tree tested→gated→CAS→promoted→receipted→trusted**) is NOT
established — 001 is open. Provider-attempt pre-dispatch journaling (002), mechanical receipt reconciliation
(004), full composite/cost truth (003), tournament replay (009), strategy bypass-trust parity (007), the
no-package fixer closure (016), and the medium/low runtime findings (008/010/011/012/014/015) are open. The
landed work is a correct, tested, regression-safe reduction of the semantic style/recovery attack surface (005,
006) and two operator-truth improvements (013 typed test evidence, 017 snapshot-leak-on-throw). The green suite
(3850/0/1) and 111/111 probe are preserved. The path to full closure is a multi-pass effort requiring test-corpus
migrations (008, 016), a promotion-pipeline reorder (001), and frozen-core journaling (002) that cannot be done
safely in a single session without destroying the verified test baseline.
