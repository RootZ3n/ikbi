# ikbi V2 — Final Audit Manifest

> **Navigation aid, not proof.** Auditors must still trace the code independently. This document
> exists to orient the final **Fable** and **Codex Sol** audits before any destructive V1 removal.

## Commit under audit

- **Branch:** `state-bound-mutation-hardening`
- **V2-017 base:** `b260c7fe40588fbdb9b23eda1f4b9ff132f9405c`
- **V2-018 (this cutover):** the HEAD commit that adds this manifest (`git rev-parse HEAD`).
- **Package:** `ikbi@0.1.0-rc.1` (release-candidate; no "stable 1.0" is claimed).

## Architecture slices

| Slice | What it established |
|---|---|
| V2-001 | canonical lifecycle / content-addressed identities / linear stage machine |
| V2-002 | configuration + model-inventory truth |
| V2-003 | canonical model-resolution authority |
| V2-004 | snapshot-bound context assembly |
| V2-005 | single model-invocation authority (real provider transport) |
| V2-006 / 006A / 006B | isolated workspaces, source snapshot, deterministic retrieval |
| V2-007 | canonical governed builder loop |
| V2-007A | untrusted-data neutralization boundary |
| V2-008 | deterministic verification |
| V2-009 | semantic critic (separately resolved) |
| V2-010 | disposition (the one lawful decision authority) |
| V2-011 | exact-tree promotion (clean-ref CAS) |
| V2-012 / 013 | bounded recovery + fresh-attempt semantic repair |
| V2-014 | cost / session accounting |
| V2-015 | governed READ-ONLY builder terminal |
| V2-016 / 016A | compatibility / cutover hardening + workspace retention |
| V2-017 | shadow + tournament candidate strategies + the one pure selector |
| **V2-018** | **production cutover: `ikbi build` → governed v2 engine; V1 → `legacy`; daily-driver qualification** |

V2-018 adds **no new subsystem** — no new mutation path, verification authority, recovery loop, or
selector. It rewires the CLI so the completed spine is the daily driver.

## Canonical production entrypoint

```
ikbi build "<goal>" [--repo <path>] [--strategy single|shadow|tournament] [--profile <name>] [--json]
        │
        └─ src/v2/cli/index.ts  runBuildCli()
              └─ executeProductionBuild()        ← THE ONE CLI call site
                    └─ runV2BuildSessionProduction()  (src/v2/runtime/index.ts)
                          └─ runBuildSession() → runV2Build()  (src/v2/core/session.ts, run.ts)
```

- `ikbi v2 build …` is a **transitional alias** onto the *same* `executeProductionBuild` (advanced,
  out of golden help). It is not a second engine.
- `ikbi legacy build …` is the **frozen V1 worker pipeline** (advanced, explicit namespace). It is
  the only reachable V1 build path and cannot be entered by accident.
- Static guards: `src/v2/cli/cutover-guards.test.ts` (one call site, no v1 import from the v2 CLI,
  `build` golden / `v2` alias / `legacy` namespaced, single default, README canonical command).

## Authority owners (one owner each)

| Concern | Owner |
|---|---|
| Lifecycle / stage machine | `src/v2/core/lifecycle.ts` |
| Identities / digests | `src/v2/core/identity.ts` |
| Configuration / policy | `src/v2/core/config.ts` |
| Model resolution | `src/v2/core/resolver.ts` |
| Context assembly / retrieval | `src/v2/core/context.ts`, `retrieval.ts` |
| Invocation | `src/v2/core/invocation.ts` |
| Workspace + state-bound mutation | `src/v2/core/workspace.ts` (over v1 worktree manager) |
| Source snapshot | `src/v2/core/source.ts` |
| Builder loop | `src/v2/core/builder.ts`, `tools.ts`, `command.ts` |
| Verification | `src/v2/core/verification.ts` |
| Critic | `src/v2/core/critic.ts` |
| Disposition | `src/v2/core/disposition.ts` |
| Promotion (clean-ref CAS) | `src/v2/core/promotion.ts` |
| Recovery + repair | `src/v2/core/recovery.ts`, `repair.ts`, `session.ts` |
| Cost / session budget | `src/v2/core/cost.ts` |
| Candidate strategy + **the one selector** | `src/v2/core/strategy.ts` |
| Production wiring | `src/v2/runtime/index.ts` |
| CLI (canonical + alias) | `src/v2/cli/index.ts` |
| Daily-driver readiness | `src/v2/runtime/readiness.ts` |

## V1 donor dependencies (still legitimately shared by V2 — NOT removable)

V2 imports these v1 primitives; they must survive V1 removal:

- `core/identity/*` — agent identity, registry, resolver
- `core/injection/*` — untrusted-data neutralization chokepoint
- `core/provider/*` — provider registry, capabilities, openai-compatible transport
- `core/substrate/{store,lock}` — atomic writes + locking
- `core/workspace/{contract,git,manager}` — git worktree management
- `modules/governed-exec/{index,sandbox}` — governed execution + bubblewrap sandbox
- `modules/profiles/{contract,storage}` — model profile config

## Legacy deletion plan (POST-AUDIT — do NOT execute in this commit)

Removable **after** final audits + qualification acceptance:

- **CLI legacy wiring:** the `legacy` registration in `src/modules/worker-model/cli.ts` and the
  `legacy` help page (`src/cli/help-pages.ts`).
- **V1 worker pipeline:** `src/modules/worker-model/` orchestrator + roles (scout/builder/critic/
  verifier/integrator) and their CLI, EXCEPT anything the shared donor list above still needs.
- **V1-only modules** not referenced by `src/v2/**` (verify with a reachability grep from the v2
  entrypoint before deletion).
- **Tests to retire/migrate:** V1 worker-model/acceptance suites that assert V1 build behavior; keep
  those pinning shared donor primitives.
- **Docs:** remove V1 5-role framing once `legacy` is deleted.

**Not removable:** the donor dependency list above; the frozen-baseline unrelated V1 failures live in
those areas and must be assessed, not bulk-deleted.

## Frozen V1 failure baseline

**9** pre-existing full-suite failures (deterministic runner), unrelated to v2: worker-model
text-emulation, role-models/model-config env defaults, sandbox toolchain-cache, lane-config mutation,
CLI model-flag cases. `>9 = regression`. V2-018 keeps the count at 9.

## Known deferred notes (carried explicitly — not hidden)

1. **Strict critic parser hardening** — unknown-field rejection, `paths` wrong-type rejection, and
   summary/defect length bounds are NOT yet enforced (protocol-compat risk deferred to audit).
2. **Verification-definition fingerprint set is finite.**
3. **No durable BuildSession resume** — the session receipt is emitted to stdout (`--json` for the
   full record); there is no durable resume journal. `ikbi doctor --v2` states this.
4. **Real provider smoke needs operator credentials** — `doctor` never spends money; see the smoke
   recipe below.
5. **Model judge remains PARKED** — selection is deterministic.
6. **Same-model tournament candidates are currently permitted.**
7. **Dirty-source publication is deliberately unsupported** — never silently committed.

## Required final-audit questions

1. Can any user-facing command perform a coding mutation/promotion OUTSIDE the canonical
   `runV2BuildSessionProduction` path after cutover? (REPL/apply/fix/server/MCP.)
2. Is there exactly one production call site to `runV2BuildSessionProduction` from CLI handling?
3. Does `ikbi build` ever reach a V1 promotion path?
4. Do `ikbi build` and `ikbi v2 build` provably reach the same handler with no behavior fork?
5. Is `legacy` unenterable by accident and clearly non-default?
6. Does the selector ever rank a weaker disposition above a stronger one to save cost?
7. Does loser-candidate cost count against the session wallet (no "winner-only" accounting)?
8. Is dirty-source publication truly impossible, and is late local work preserved (stash) not lost?
9. Are exit codes stable and script-distinguishable (see below)?

## Exit-code contract (`exitCodeForOutcome`)

| Outcome | Exit | Meaning |
|---|---|---|
| `accepted` | 0 | promoted |
| `withheld` | 0 | verified work retained, not promoted (incl. eligible-awaiting / operator-required / no-checks) |
| `rejected` | 1 | adjudicated not promotable |
| `quarantined` | 2 | safety forensics — do not reuse blindly |
| `failed` | 1 | run failed before adjudication |

Reconciliation-required (a landed publication whose post-CAS bookkeeping did not finish) is surfaced
in the session receipt (`reconciliationRequired`) and rendered loudly; the terminal outcome remains
`accepted`/degraded (the ref moved — do NOT re-publish).

## Qualification suite commands

```bash
pnpm build
# Normal-command cutover proofs (real built binary + fake provider):
node --import tsx --test src/v2/cli/cli-subprocess.test.ts
# In-process reachability + parser:
node --import tsx --test src/v2/cli/reachability.test.ts
# Static cutover guards:
node --import tsx --test src/v2/cli/cutover-guards.test.ts
# Daily-driver readiness:
node --import tsx --test src/v2/runtime/readiness.test.ts
# The engine matrix the normal command provably reaches (edit/verify/repair/recovery/cost/strategy):
node --import tsx --test 'src/v2/**/*.test.ts'
# Live real-model smoke (operator credentials; spends money — NOT run by doctor/CI):
#   node dist/cli/index.js build "change one constant in README" --repo /tmp/ikbi-smoke --json
```

## Where the deeper qualification scenarios are proven

The normal command (`ikbi build`) provably reaches the engine (equivalence + one-call-site guard), so
the engine suites qualify it: verification-fail→repair and critic-defect→repair (`session-repair.test.ts`,
`repair.test.ts`), provider-failure→fresh attempt + stale-target recovery (`recovery.test.ts`,
`session.test.ts`, `run.test.ts` MOVED-target), budget exhaustion (`cost.test.ts`,
`session.test.ts`), dirty-source refusal + late-work stash (`promotion.test.ts`, `run.test.ts`),
terminal confinement + read-only (`terminal-e2e.test.ts`, `command.test.ts`), shadow/tournament +
no-eligible + loser cleanup + per-candidate cost (`run.test.ts`, `strategy.test.ts`), served-model
alias accounting (`invocation.test.ts`, `cost.test.ts`), malformed-critic accounting (`critic.test.ts`).
Headline scenarios are additionally driven through the REAL `ikbi build` binary in
`cli-subprocess.test.ts`.
