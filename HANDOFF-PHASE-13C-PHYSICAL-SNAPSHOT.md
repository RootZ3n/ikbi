# HANDOFF — Phase 13C: Physical Frozen Verification Snapshot

The final Phase 13 containment pass. It adds a PHYSICALLY ISOLATED, read-only verification snapshot (a detached
git worktree pinned to the candidate's committed verified tree), binds promotion to it, fails closed when a
git-backed candidate cannot be physically frozen, and makes the builder tool loop honor the cooperative abort.
It does NOT claim the full universal write-lease + governed-child-abort + test-execution-on-snapshot forms —
those remaining items are documented explicitly below with rationale.

## Verified starting state
- HEAD `7a1426c` (Phase 13B); branch `harness/cc-parity-and-bokahli-pilot`; 221 ahead of origin; tracked tree clean.
- Pre-existing untracked files (`.claude/`, audit/re-audit/consolidated reports, `ikbi-0.1.0-rc.1.tgz`,
  `scripts/ui-verify/package-lock.json`) left untouched.

## Complete project-controlled write inventory (from parallel read-only investigators)
| Path | fs seam | Chokepoint? | Interceptable |
|---|---|---|---|
| `write_file` | `builder-tools/confine.ts:writeConfinedFile` (openSync O_NOFOLLOW + writeFileSync) | shared helper for write_file only | yes (shared) |
| `patch` | `builder-tools/patch.ts:90` direct `writeFileSync` | none | yes (per-tool) |
| `multi_edit` | `builder-tools/multi-edit.ts:108` direct `writeFileSync` | none | yes (per-tool) |
| `delegate` write_file | `builder-tools/delegate.ts:142-143` direct mkdir+writeFileSync | own sub-agent path | yes (per-tool) |
| `terminal` | `builder-tools/terminal.ts` → `governedExec.run` → spawned binary | policy allowlist + OS sandbox only | **NO (external child)** |
| tournament/consult diff | `orchestrator.defaultApplyDiff` → `git apply` (governed) | Phase 13B write-boundary lease | yes (lease-checked) |
There is **no single project-wide candidate-write chokepoint** — writes are scattered across `write_file`
(confine), `patch`, `multi-edit`, `delegate`, and `terminal` (governed child, uninterceptable at the builder).

## Remaining external / uninterceptable mutation paths
- `terminal` governed commands (git/npm/tsc/…) mutate files by spawning child processes; the OS sandbox +
  command policy confine them to the worktree but they do NOT pass through `CandidateLeaseRegistry.checkWrite`.
- The builder's inner `write_file`/`patch`/`multi_edit`/`delegate` writes are not yet routed through the lease
  registry (they were not threaded a lease this pass). See remaining boundaries.

## Lease-aware write abstraction
`CandidateLeaseRegistry.checkWrite(lease)` (Phase 13B, `candidate-lease.ts`) is the write gate. It is wired at
the orchestrator `defaultApplyDiff` seam (a fenced/revoked generation's diff-apply is rejected with a
`worker.write_fenced` receipt). It is NOT yet the mandatory gate for the scattered builder tool writes — that
threading is the primary remaining item.

## Abort propagation map
- `RoleContext.signal` (Phase 13) → aborted by `runRoleFn` on role timeout.
- **NEW (Phase 13C):** the builder tool loop (`builder.ts` ~1650) now checks `ctx.signal?.aborted` between
  iterations and breaks with `stopReason: "aborted"` — a timed-out builder stops scheduling tools + mutating.
- **NOT yet propagated:** the provider adapter invocation, `governedExec.run` (its `ExecRequest` has no
  `signal` field), child-process runners, fixer/iterative-repair/critic. Deferred.

## Child-process termination behavior
`governed-exec` already spawns with `detached: true` (own process group) and can `process.kill(-pid, SIGKILL)`
the whole group; background jobs do SIGTERM→grace(`killGraceMs`)→SIGKILL. But there is NO `AbortSignal` wired
into `ExecRequest` — a governed command is killed by its own `timeoutMs`, not by the role's abort. Binding the
role abort to governed-exec forced termination is deferred (documented).

## Operation-isolated workspace design
Not implemented this pass — governed mutating commands still run in the candidate worktree
(`cwd: workspace.path`). The physical SNAPSHOT (below) is the isolated read-only artifact promotion binds to;
running mutating operations in per-operation copies is a documented remaining item.

## Physical snapshot implementation (`workspace-snapshot.ts`, new)
`createPhysicalSnapshot(sourceWorktreePath, expectedTree?)`:
1. Resolve the source's committed `HEAD` + `HEAD^{tree}` (a non-git / no-commit source ⇒ returns `undefined`,
   caller keeps the Phase 13B logical binding).
2. FAIL-CLOSED tree check: if `expectedTree` (the verified tree) ≠ the source committed tree, throw.
3. `git worktree add --detach --quiet <tmp> <commit>` — a physically isolated checkout at a SEPARATE tmp path,
   pinned to the content-addressed commit (its tree hash IS the canonical digest).
4. IDENTITY: the isolated checkout's `HEAD^{tree}` must equal the expected tree.
5. IMMUTABILITY: recursively `chmod a-w` the working files, then PROVE it by opening a file `O_WRONLY` (must
   fail); if it opens writable, throw (fail-closed).
6. Return `{ snapshotPath, gitTree, gitCommit, canonicalDigest, immutable, createdAt, cleanup() }`.
`verifySnapshotUnchanged` re-reads the tree + re-probes read-only. `cleanup()` restores write perms + `git
worktree remove --force` (idempotent). SCOPE: git-backed candidates only.

## Filesystem immutability enforcement
Working files are `0o444`/dirs `0o555` (excluding the `.git` pointer); a write probe confirms EACCES; the
git object store is content-addressed so the recorded tree cannot change. `verifySnapshotUnchanged` re-checks
both tree identity and read-only before promotion. A source mutation (even a new commit) cannot alter the
detached snapshot (proven by test A3).

## Test execution target
UNCHANGED this pass: the verifier still runs deterministic checks/tests with `cwd: ctx.workspace.path` (the
mutable candidate), THEN the work is committed, THEN the physical snapshot is frozen from that committed tree.
So the snapshot IS a physical copy of exactly the tested tree (identical `HEAD^{tree}`), but tests do not yet
execute INSIDE the snapshot. Redirecting the verifier `cwd` to the snapshot (and the pipeline reorder it
implies) is a documented remaining item.

## Semantic / runtime-truth target
UNCHANGED this pass: the critic binds to `candidateId`/`verifiedTree` (== the snapshot digest) and the
`semanticEvaluationId`; runtime-truth binds to the verified tree. The critic still reads the workspace diff
(not the snapshot path). Reconstructing critic evidence FROM the snapshot path is a documented remaining item.

## Promotion source and identity confirmation
Promotion binds to the physical snapshot: the `worker.promotion` receipt carries `snapshotPath`,
`snapshotImmutable`, `snapshotKind:"physical-isolated"` (git-backed) or `"logical"` (non-git), and
`snapshotDigest == verifiedTree`. Immediately before promotion, `verifySnapshotUnchanged` re-confirms the
frozen subject; the existing stale-tree re-read + `WorkspaceManager` CAS (`landedTree == integratedTree ==
verifiedTree == snapshotDigest`) confirm the PROMOTED content equals exactly the frozen tree. `promote()` lands
the scratch branch's committed tree (which equals the snapshot's content-addressed tree). A source mutation
after freeze cannot change the snapshot's tree and is caught by the stale-tree/CAS. **Note:** promotion still
lands via the git ref (scratch branch), not by copying files FROM the snapshot path — but both resolve to the
identical content-addressed tree the CAS confirms, so the promoted content equals the frozen subject.

## Generation supersession behavior
Unchanged from Phase 13B (`CandidateLeaseRegistry`): a new generation supersedes the prior active one on a
workspace; revoking one generation does not revoke unrelated ones; a superseded/timed-out generation's leases
cannot write and cannot be frozen; primary/peer/fixer/multi-step/tournament are distinct generations.

## Snapshot cleanup
`physicalSnapshot.cleanup()` runs ONLY AFTER the promote decision + its `worker.promotion` receipt are durable
(never before). It restores write perms then `git worktree remove --force`. Verified no leak from production
runs (0 leftover `ikbi-snap-*` after clean git-backed runs). The integrity/drift branches also clean up.

## Files changed
- **new** `src/modules/worker-model/workspace-snapshot.ts` — physical detached-worktree snapshot + immutability
  enforcement + verify + cleanup.
- `src/modules/worker-model/orchestrator.ts` — `deps.createPhysicalSnapshot`; capture the physical snapshot at
  the fence-clear promote point (git-backed, real-tree only); fail-closed `worker.promotion.snapshot_integrity_error`;
  verify-unchanged before promote; `snapshotPath`/`snapshotImmutable`/`snapshotKind` on the candidate + receipt;
  cleanup after promotion+receipt.
- `src/modules/worker-model/builder.ts` — the tool loop breaks on `ctx.signal?.aborted` (`stopReason:"aborted"`).
- **new** `src/modules/worker-model/phase13c-physical-snapshot-conformance.test.ts` — 10 tests.

## Retained tests (10, all green) — maps to the required list
- **A1–A6** physical snapshot (real git): separate physical path (1); read-only enforced + write-probed (2,4,5);
  source mutation after freeze does not change it (3,14); tree-mismatch fails closed (16,30); non-git ⇒ no
  physical snapshot / logical binding (3); cleanup removes the worktree (36).
- **B1** git-backed promote binds the physically-isolated snapshot on the receipt (6,7,8,13,15).
- **B2** a physical-snapshot integrity failure fails closed — no promote, no success trust (16,17,30,31).
- **B3** a non-git candidate keeps the logical binding + promotes (3).
- **C1** an aborted `ctx.signal` stops the builder tool loop before scheduling tools; no candidate mutation (28,33).
- Covered green by prior suites: 18–25 (lease authority — Phase 13B unit tests), 26/29 (governed-exec kill —
  existing governed-exec tests), 34/35 (supersession — Phase 13B), 38/39 (bypass trust / manual apply — 13/13B),
  40 (all Phase 1–13B conformance), 41 (probe).

## Mutation guards (demonstrated FAIL → revert)
| # | Mutation | Guard | Result |
|---|---|---|---|
| 1 | snapshot path == source workspace path | A1 | fail → revert → pass |
| 7 | remove the builder abort check (aborted output applied) | C1 | fail → revert → pass |
| 10 | snapshot integrity failure not fail-closed (still promotes) | B2 | fail → revert → pass |

(Guards 2–6,8,9 are pinned by the same retained tests: A2 read-only, A3 source-survival, B1 promotion binds
snapshot, A6 cleanup. Reverts verified clean.)

## Commands + results
- `pnpm build` — clean (tsc strict).
- Physical-snapshot integration (real git, standalone): passes (separate path, immutable, source-survival, cleanup).
- Phase 13C suite (tsx): **10 / 10**. Phase 13 / 13B: **12/12, 15/15** (no regression).
- Full worker-model suite: **1290 / 1290** (was 1280 → +10). Builder suite: **70/70**.
- Full `pnpm test`: **3747 tests, 3746 pass, 0 fail, 1 skipped** (was 3737 → +10).
- Production-config probe (isolation=none, `.env`, **`IKBI_GATE_WALL_BYPASS=false`**): **111 / 111**.
- No paid provider calls. **Child-process termination:** unchanged (governed-exec kills its own process group on
  its `timeoutMs`; role-abort→forced-kill not yet wired). **Temporary-resource leaks:** none — 0 leftover
  `ikbi-snap-*` worktrees after clean runs. **Abort timing:** the builder checks abort at iteration granularity.
  **Filesystem permission:** `chmod a-w` + `O_WRONLY` probe (POSIX; on a platform without permission enforcement
  the write probe would surface it as an integrity failure → fail-closed). **`.env`-dependent:** the pre-existing
  `worker-model.cli.test.ts` env-selection artifact (documented Phase 12) is unchanged and unrelated.

## Answers to the phase's questions
- **Do tests and promotion use the identical physical snapshot?** Promotion binds to + confirms (via CAS) the
  physical snapshot's content-addressed tree, which is IDENTICAL to the tree the verifier tested. But tests
  still EXECUTE in the mutable workspace (not inside the snapshot) — so identity is guaranteed, physical
  test-isolation is NOT yet. **Partially achieved.**
- **Can source mutations after freezing affect promotion?** No — the physical snapshot is immutable to source
  mutations (test A3), `verifySnapshotUnchanged` re-checks before promote, and the stale-tree/CAS refuse a
  divergent live tree.
- **Can timed-out child/provider output reach the current candidate?** A timed-out BUILDER is now aborted at
  the tool loop (stops scheduling tools) + fenced from promotion. A governed CHILD process still runs to its own
  `timeoutMs` and is not yet abort-bound; its output cannot PROMOTE (fence + stale-tree/CAS) but can still reach
  disk. **Partially achieved.**
- **Is Phase 13 fully confirmed?** The promotion-authority guarantees are confirmed + strengthened with a
  physically isolated, immutable, verified snapshot subject. The physical test-execution + universal write-lease
  + governed-child-abort forms are NOT yet complete.
- **Phases 1–12 intact?** Yes — all prior conformance suites + the 111/111 probe are green.

## Remaining boundaries / not globally fixed (explicit)
- **Tests still execute in the mutable workspace**, not inside the snapshot (identity-bound, not physically
  isolated). Redirecting the verifier `cwd` to a snapshot execution copy + the pipeline reorder is deferred. **[audit target]**
- **Builder tool writes (`write_file`/`patch`/`multi_edit`/`delegate`) are not lease-gated** — they remain
  governed by the promotion-time mutation fence + the physical snapshot binding, not a per-write lease. **[audit target]**
- **`terminal` governed child processes** mutate files uninterceptably (OS sandbox + policy only); not
  operation-isolated, not abort-bound, no forced kill on role abort. **[audit target]**
- **Abort not propagated to provider / governed-exec / child** with forced termination — only the builder tool
  loop honors it. **[enhancement]**
- **Promotion lands via the git ref** (scratch branch), which resolves to the identical content-addressed tree
  as the snapshot (CAS-confirmed), rather than copying files from the snapshot path. **[documented — equivalent by content identity]**
- **REAUDIT2-003/-004/-005/-006/-007** remain out of scope (later phases). **[audit target]**

## Commit
One cohesive commit (the physical snapshot, its promotion binding, the fail-closed integrity gate, and the
builder abort check are one interlocking pass sharing `orchestrator.ts`; splitting would risk a non-green
intermediate): `fix(verification): promote physically isolated read-only tested snapshots`. Not pushed.
