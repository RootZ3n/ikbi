# ikbi — Post-V1 Architecture

_State after **V2-020** (legacy dependency extraction + v1 build-spine retirement)._

This is the map of what ikbi is now: one build authority, what still exists beside it, and
exactly which legacy machinery survives and why. It is documentation, not proof — every claim
here has a guard or a test named next to it.

---

## 1. The one build authority

`ikbi build "<goal>" --repo <path>` is **the** production build engine (v2). One SourceSnapshot per
run, isolated candidate workspace(s), deterministic verification, a semantic critic, one adjudicated
disposition, and publication by a single clean-ref compare-and-swap. There is no second engine, no
fallback path, and no model escalation.

`ikbi v2 build …` remains a **deprecated alias** for the same call site. It is kept for one release
so existing scripts and agent skills do not break; a guard pins that both funnel through exactly one
production call site (`cutover-guards.test.ts`).

## 2. Canonical CLI surfaces

| Command | Engine | Mutates? | Promotes? | Status |
|---|---|---|---|---|
| `build` | **v2** | yes (isolated workspace) | yes (one ref CAS) | **canonical** |
| `v2 build` | **v2** | yes | yes | deprecated alias for `build` |
| `legacy` | none | no | no | **tombstone — refuses, exit 2** |
| `run --spec` | **v1** | yes | yes | retained, explicitly labelled legacy (§5) |
| `fix` | v1 repair pipeline | yes (narrow) | **never** | retained, non-promoting by design |
| `repl` | chat tools | yes (managed worktree, `/apply`) | via `/apply` only | retained; reaches **no** v1 build spine |
| `serve` | — | build endpoint **disabled** | no | read-only + non-build capabilities only |
| `doctor`, `receipts`, `cost`, `inspect`, `undo`, `workspace*`, `clean`, `audit`, `health` | — | no | no | inspection/operator |

## 3. Authority graph (build path)

```
ikbi build
  └─ v2/cli  →  v2/runtime (adapters)  →  v2/core (pure authorities)
                     │
                     ├─ core/workspace/git.ts        source snapshot, worktrees, the ONE ref CAS
                     ├─ core/provider/*              provider registry + capability facts
                     ├─ core/identity/*              verifier identity + operation context
                     ├─ core/injection/*             untrusted-data neutralization fence
                     ├─ modules/governed-exec/*      the governed check executor + sandbox
                     ├─ modules/checks/              deterministic check DISCOVERY  ← NEUTRAL (new)
                     └─ modules/profiles/*           read-only profile loading
```

**v2 imports zero worker-model modules at runtime.** Proven two ways: a static guard
(`isolation.test.ts` — "NO part of v2 imports modules/worker-model") and a runtime-graph walk over
built `dist/` output.

## 4. Retained shared primitives (neutral owners)

| Primitive | Home | Who uses it |
|---|---|---|
| Check discovery (`resolveChecks`, `IKBI_CHECKS`, project-root detection, timeout policy) | `src/modules/checks/` | v2 verification, v1-era callers (via re-export), doctor |
| Terminal I/O (`readPipedStdin`, `colorizeDiff`) | `src/cli/terminal-io.ts` | `repl`, `run`, worker-model CLI |
| Git primitives, provider facts, identity, injection fence, governed-exec, profiles | `src/core/*`, `src/modules/*` | v2 + retained surfaces |

`modules/worker-model/checks.ts` is now a **re-export** of `modules/checks`, not a fork — one
implementation, one behaviour.

## 5. What legacy machinery still exists, and why

**Removed:** the `ikbi legacy build` command (the only way an operator could type their way into the
v1 engine) and the HTTP build endpoint that launched it.

**Retained, deliberately:** the v1 orchestrator and its role pipeline are still *reachable code*,
because four production surfaces still construct it:

- `cli/run.ts` — the external-agent **task-file contract** (spec in, one terminal JSON document out,
  stable `RUN_*` codes external agents depend on). v2 does not expose this contract yet.
- `cli/heal.ts` and `modules/batch-planner/cli.ts` — self-heal and batch decomposition.
- `src/acceptance/harness.ts` — acceptance test infrastructure.

Deleting the orchestrator today would break those surfaces, not remove dead code. The honest state
is therefore: **the v1 build spine is no longer a hidden production authority — it is a named,
labelled, single-surface dependency** (`ikbi run`), announced on stderr at every invocation.

### Next convergence step (not done here)

Migrate the `run --spec` task-file contract onto a v2 BuildSession. That is a real mapping job
(`WorkerResult` role/promotion/cost shape → v2 session result), not a relabel. When it lands,
`heal` and `batch` follow, and the orchestrator and its role pipeline can be deleted outright.

## 6. Removed in V2-020

- `ikbi legacy build` command (replaced by a refusing tombstone so the old invocation cannot be
  silently reinterpreted as a REPL chat prompt).
- The HTTP `liveRunBuild` v1 execution path (fails closed with a migration message).
- v2's dependency on `modules/worker-model/checks.ts` (extracted to `modules/checks`).
- `repl`'s transitive dependency on the v1 orchestrator (it existed only because two terminal
  helpers lived in the worker-model CLI file).
- Raw NUL bytes in TypeScript sources (they made `grep`/`file` treat `v2/core/cost.ts` as binary,
  so every grep-based static guard silently skipped the canonical cost authority).

## 7. Hardening landed in V2-020

| Item | Change |
|---|---|
| Content-addressed identity | `contentDigest(kind, value)` now **commits to `kind`** (`sha256("ikbi/v2/" + kind + NUL + canonicalJson)`); previously `kind` was accepted and ignored, so different kinds could collide. |
| Recovery taxonomy | `verification_policy_changed` is classified apart from `verification_failed`: it grants **no** semantic repair and **no** automatic retry (`require_operator`). |
| Critic parser | Unknown top-level/defect fields refused; non-array or non-string `paths` refused rather than coerced to `[]`; summary, defect description and defect count bounded. |
| Builder command policy | `git cat-file` removed — it enumerates the git object store that tournament/shadow siblings **share**, which was a cross-candidate read channel. |
| Doctor readiness | `governed-exec` now resolves the repository's **actual** check commands and verifies each is allowlisted, reporting READY / DEGRADED / NOT READY instead of "the allowlist is non-empty". |

## 8. Test posture

- `pnpm build` — green (strict, typechecks tests too).
- Full deterministic suite — **5163 tests, 0 failures, 1 skipped.**
- No expected-failure allowlist exists for retired v1 behaviour.
- External-fixture qualification (`src/v2/cli/external-fixture-qualification.test.ts`): the shipped
  `dist/cli/index.js` builds a disposable **external** repository end-to-end through all nine
  lifecycle stages, single strategy, against a local fake provider.

## 9. Deferred (explicitly, not forgotten)

- **`run`/`heal`/`batch` migration to v2** — see §5. The blocker on deleting v1 orchestration.
- **Durable session resume** — not implemented. The git ref/tree is the authoritative landing proof;
  the filesystem journal is best-effort and its write status is reported, never disguised as crash
  durability. `doctor --v2` states this.
- **`verification_policy_changed` entitlement** — now correctly non-repairable (§7), but the
  *operator* workflow for adjudicating a legitimate definition change is still manual.
- **Same-model tournament diversity** — a tournament of one model is a tournament in name only.
- **Sibling worktrees still share one git object store** — `cat-file` is closed (§7), but the
  isolation is policy-level, not storage-level.
