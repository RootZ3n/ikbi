# HANDOFF — Phase 13B: Frozen Verification Snapshot + Generation-Scoped Leases

A narrow Phase 13 completion pass. It strengthens the immutable-verification invariant with a
**generation-scoped mutation authority**, a **write-boundary lease check**, an explicit **frozen verification
snapshot bound to the promotion evidence**, and **truthful bypass trust** (a gate-bypassed promote earns no
governed-success trust). It does NOT claim the fully-physical form (a read-only copy the writer cannot touch,
fs-write leases inside the builder tool loop, provider/child abort with forced termination) — those are
explicitly documented as remaining below.

## Verified starting state
- HEAD `52f450d` (Phase 13); branch `harness/cc-parity-and-bokahli-pilot`; tracked tree clean.
- Pre-existing untracked files (`.claude/`, the audit/re-audit/consolidated reports, `ikbi-0.1.0-rc.1.tgz`,
  `scripts/ui-verify/package-lock.json`) left untouched.

## Pre-change fence granularity (inventory, required first task)
`MutationFence` (Phase 13, `orchestrator.ts`): the REGISTRY is keyed by `taskId` (`activeMutationFences`), but
its internal ticks (`lastMutatingTimeout`/`lastCleanMutation`) are keyed by **workspaceId** — so it is already
WORKSPACE-scoped, not task-only. Findings:
- **Primary vs peer:** different attempts run as separate `run()` calls with distinct `taskId`s → distinct
  fences (and distinct workspaces). Not shared.
- **Fixer vs source:** the fixer dispatches as `builder` on the SAME workspace → shares the workspace fence; a
  clean fixer generation supersedes a prior timeout (tick ordering). Correct but not generation-explicit.
- **Multi-step (reuseWorkspace):** steps share a workspace → shared fence; a clean later step supersedes.
- **Tournament/competitive:** each candidate has its own `workspace.id` → independently fenced. Not shared.
- **False-fencing:** limited — a clean generation on the same workspace supersedes; a different workspace is
  unaffected.
- **Write vs promotion checks:** the fence was consulted ONLY at promotion (candidate construction), never at
  a write. No generation identity, no lease, no snapshot. ← the gaps Phase 13B closes.

## Candidate-generation model (`candidate-lease.ts`, new)
`CandidateGeneration` = {runId, taskId, attemptId, candidateId, **generationId**, workspaceId, workspacePath?,
sourceGenerationId?, openedAtTick} with a `GenerationLifecycle` of `active | timed-out | revoked | superseded |
frozen`. A NEW generation is opened per mutation round (builder retry, peer, fixer, multi-step step,
tournament/competitive candidate). Opening a new generation on a workspace **supersedes** the prior active one
there (tick-ordered). `generationId = ${taskId}:${workspaceId}:gen${seq}`.

## Mutation-lease lifecycle
`MutationLease` = {leaseId, generationId, workspaceId, operationId, issuedAtTick, signal?}. `issueLease` throws
for a non-active generation. `isLeaseValid`/`checkWrite` return false when the generation is not active, the
lease is closed/revoked, or its `AbortSignal` is aborted. `revokeGeneration(id, "timed-out"|"revoked")`
invalidates all its leases. `recordMutatingTimeout(ws)` revokes the current generation (the Phase 13 fence,
now generation-precise). `closeLease` on clean completion.

## Write-boundary coverage
`CandidateLeaseRegistry.checkWrite(lease)` is the write gate. Wired in the orchestrator at `defaultApplyDiff`
(the tournament/consult candidate diff-apply seam): before applying a diff, if the workspace's current
generation is fenced (revoked/timed-out) the write is **rejected before mutation** with a `worker.write_fenced`
receipt. **Coverage today:** the orchestrator-reachable `applyDiff` seam. **NOT yet covered:** the builder's
inner `write_file`/tool fs writes (they live in `builder.ts`'s tool layer, out of this narrow pass) — those
remain governed by the Phase 13 promotion-time fence. See remaining boundaries.

## Abort propagation
Phase 13 threads an `AbortSignal` onto `RoleContext.signal` (aborted on role timeout). Phase 13B carries the
signal on the lease so `checkWrite` rejects an aborted operation's late output. **NOT yet done:** propagating
the signal into the provider adapter / governed-exec / child processes with forced termination + grace period.
Deferred (documented).

## Child-process termination behavior
Unchanged from Phase 13: the identity/git probes use synchronous `execFileSync` (10s timeout, no lingering
async child). Governed-exec child termination on abort is a documented remaining item.

## Snapshot design + immutability enforcement
`VerificationSnapshot` = {snapshotId, runId, taskId, attemptId, candidateId, generationId, sourceWorkspaceId,
**canonicalDigest**, gitTree?, baseIdentity?, createdAtTick, lifecycle:"frozen"}. `canFreeze(generationId)` is
FAIL-CLOSED: allowed ONLY when the generation is active, has NO active mutation lease, and is still the
workspace's current generation (not timed-out/revoked/superseded). `freeze()` marks the generation `frozen`
(no further leases can issue — the subject is immutable) and stores the snapshot. **The immutable subject IS
the git tree object** (content-addressed) captured as `canonicalDigest`/`gitTree` = the candidate's
`verifiedTree`. The orchestrator freezes at the normal promote point when the fence is clear + identity
resolved + a verified tree exists.

## Test / semantic / runtime-truth binding
The promotion receipt now carries `snapshotId` + `snapshotDigest` (== `verifiedTree`). The existing
`semanticEvaluationId` binds the critic verdict to the candidate/tree; the run-summary + promotion receipts
carry the snapshot digest. **Enforcement of "promote == snapshot":** the existing stale-tree re-read (live
`HEAD^{tree}` must equal the candidate's `verifiedTree` = the snapshot digest) + the `WorkspaceManager` CAS
(`landedTree == integratedTree`) confirm the promoted content equals exactly the frozen subject. **NOT done:**
running the executed tests against a separate physical read-only copy — tests still execute in the workspace;
the snapshot identity + stale-tree/CAS bind the subject, but the test process is not physically isolated from a
late writer. Deferred.

## Promotion-from-snapshot flow
Unchanged sequence (Phase 10/13) with the snapshot bound: resolve base identity → tree-identity fail-closed →
mutation-fence → identity-indeterminate → stale-tree (live == snapshot digest) → `verifiedAgainst` CAS →
promote → `landedTree == snapshot digest` (CAS) → receipt carries `snapshotId`. A promoted tree that differs
from the snapshot is refused by the CAS.

## Post-snapshot mutation behavior
Freezing marks the generation `frozen`; the registry rejects any new lease on it — a post-snapshot mutation
cannot occur under the same generation. If new content is to be considered, a new generation must be opened
(and it would require a fresh freeze/tests). A late uncommitted-then-committed source write changes the live
tree away from the snapshot digest → the stale-tree/CAS refuses. The snapshot identity is never silently
updated.

## Gate-bypass authority + trust behavior
Phase 13 made the receipts truthful (`gateBypassed`/`gateAuthority:"administratively-bypassed"`). Phase 13B
adds the TRUST semantics: a successful promote whose gate allow came from `governance.bypass` sets a per-run
`gateBypassedThisBuild` flag that (a) suppresses the governed success-trust signal (a `worker.trust.
signal_suppressed` receipt records why — no fully-governed success is awarded), and (b) surfaces
`gateBypassed:true` + `gateAuthority:"administratively-bypassed"` on the run summary. No separate positive
trust class was added (suppression is the conservative choice — no partial governed credit). The production
probe runs with `IKBI_GATE_WALL_BYPASS=false`.

## Manual-apply interaction (unchanged / preserved)
Manual `/apply` remains manual-unverified (Phase 10/13), hash/identity-bound (refuses on indeterminate git
identity), awards no governed success trust, and needs no promotion snapshot. Phase 13B does not conflate it
with gate-bypassed autonomous application.

## Files changed
- **new** `src/modules/worker-model/candidate-lease.ts` — `CandidateGeneration`, `MutationLease`,
  `VerificationSnapshot`, `CandidateLeaseRegistry` (the generation-scoped mutation + write-boundary + freeze
  authority).
- `src/modules/worker-model/orchestrator.ts` — per-run lease registry lifecycle (`activeLeaseRegistries` +
  `fencedRun`); write-boundary check + `worker.write_fenced` in `defaultApplyDiff`; frozen-snapshot capture +
  `snapshotId`/`snapshotDigest` on the candidate + `worker.promotion` receipt; bypass trust suppression +
  `gateBypassed` on the run summary.
- **new** `src/modules/worker-model/phase13b-frozen-snapshot-conformance.test.ts` — 15 tests.

## Retained tests (15, all green) — maps to the required list
- **A1–A12** (CandidateLeaseRegistry unit — the production authority): generation-scoped leases (req 1);
  primary/peer distinct (2,26); fixer derived + source (3,27); multi-step/tournament distinct (4,28,29);
  revoke isolation (5); stale-op cannot write newer generation (6); revoked lease blocks write/patch (7,8);
  aborted signal blocks late output (9); generation-precise fence + supersession (12); no freeze with active
  lease (14); no freeze from timed-out/superseded (15,16); stable frozen snapshot identity + immutability (17,18).
- **B-snapshot** promotion receipt binds the frozen snapshot id + digest == verified tree (20,22,23,30).
- **C-bypass-trust** a bypassed promote earns NO governed-success trust + is surfaced (32,33,34);
  **C-governed-trust** control (a governed promote DOES earn success trust).
- Reqs covered green by prior suites: 10–13 (Phase 13 fence/abort), 19/21 (verifier/runtime-truth binding),
  25 (new generation), 31 (CAS), 35/36 (Phase 1–13 + probe), 37/38.

## Mutation guards (demonstrated FAIL → revert)
| # | Mutation | Guard | Result |
|---|---|---|---|
| 2 | a revoked op can write (`checkWrite` always ok) | A7 | fail → revert → pass |
| 7 | freeze ignores active leases | A10 | fail → revert → pass |
| 9 | aborted signal ignored at the write boundary | A8 | fail → revert → pass |
| 8 | bypass awards governed-success trust | C-bypass-trust | fail → revert → pass |
| 4/5 | snapshot id not bound to the promotion receipt | B-snapshot | fail → revert → pass |

(Guards 1,3,6,10 are pinned by the same retained tests — A1 generation-scoping, A12 immutable-frozen, A6
stale-op write, and the CAS `landedTree==snapshot` in the workspace-manager suite. Reverts verified clean.)

## Commands + results
- `pnpm build` — clean (tsc strict).
- Phase 13B suite (tsx): **15 / 15**.
- Full worker-model suite: **1280 / 1280** (was 1265 → +15).
- Full `pnpm test`: **3737 tests, 3736 pass, 0 fail, 1 skipped** (was 3722 → +15).
- Production-config probe (`orchestrator.test.ts`, isolation=none, `.env`, **`IKBI_GATE_WALL_BYPASS=false`**):
  **111 / 111**.
- Phase 13 / promotion-authority / gate-wall suites: **12/12, 13/13, 14/14** (no regression).
- No paid provider calls. No child-process leaks observed (git probes are `execFileSync`; the lease registry is
  pure in-memory). `.env`-dependent difference: the pre-existing `worker-model.cli.test.ts` "gate-denied
  promote" env-selection artifact (documented Phase 12) is unchanged and unrelated.

## Answers to the phase's questions
- **Do tests and promotion always use the identical frozen snapshot?** The promotion is bound to the snapshot
  digest and the stale-tree/CAS confirm the promoted content equals it. The tests are NOT yet run against a
  physically separate read-only copy — they run in the workspace, then the snapshot digest + fence + stale-tree
  bind the subject. So: promotion applies exactly the frozen (content-addressed) subject; test execution is
  bound by identity, not yet physically isolated. **Partially achieved — see remaining.**
- **Can any late operation affect a promotable candidate?** At the orchestrator write seam (`applyDiff`), no —
  a fenced generation's write is rejected. A frozen generation cannot issue new leases. The builder's inner
  fs writes are not yet lease-gated; a post-timeout inner write is caught by the promotion-time fence + the
  stale-tree/CAS (it cannot promote), but it can still reach disk. **Partially achieved.**
- **Can bypassed runs receive governed-success trust?** No — the governed success-trust signal is suppressed
  and the bypass is surfaced.
- **Is Phase 13 now fully confirmed?** The authority/receipt/fence guarantees are confirmed and strengthened
  (generation-scoped + write-boundary + snapshot-bound). The physical-isolation forms are not yet complete.
- **Phases 1–12 intact?** Yes — all prior conformance suites + the 111/111 probe are green.

## Remaining boundaries / not globally fixed (explicit)
- **No physical read-only test copy** — executed tests still run in the mutable workspace; the frozen subject
  is bound by snapshot digest + stale-tree/CAS, not by a copied read-only tree the writer cannot touch. **[audit target / enhancement]**
- **Builder inner fs-write lease** — `write_file`/tool writes inside `builder.ts` are not yet routed through
  `checkWrite`; they remain governed by the promotion-time mutation fence. **[audit target]**
- **Abort not propagated to provider/governed-exec/child** with forced termination + grace period — the signal
  is plumbed onto the context + lease but honoring it end-to-end is deferred. **[enhancement]**
- **Generation wiring is minimal in the orchestrator** — a full generation is opened at the `applyDiff` seam
  and at the normal-path freeze; retries/fixer/peer/tournament do not each explicitly open a generation in the
  orchestrator yet (they are covered by the workspace-scoped fence + the unit-proven registry). **[enhancement]**
- **Bypass = suppression, not a separate positive trust class** — no operator-directed credit is awarded under
  bypass (conservative). **[documented]**
- **REAUDIT2-003/-004/-005/-006/-007** remain out of scope (later phases). **[audit target]**

## Commit
One cohesive commit (the lease authority, write-boundary, snapshot binding, and bypass trust are one
interlocking pass sharing `orchestrator.ts`; splitting the shared file would risk a non-green intermediate):
`fix(verification): generation-scoped leases + frozen snapshot binding + truthful bypass trust`. Not pushed.
