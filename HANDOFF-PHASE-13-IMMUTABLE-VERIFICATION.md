# HANDOFF — Phase 13: Immutable Verification (fence timed-out mutations · fail-closed identity · truthful bypass)

Closes the CRITICAL/HIGH findings of the second independent re-audit (`IKBI-RUNTIME-CONFORMANCE-REAUDIT-2.md`):
**IKBI-REAUDIT2-001** (a timed-out, uncancellable candidate-mutating role could promote a tree the executed
tests never saw), **-002** (a paired git-probe failure reclassified a real worktree as exempt and dropped
stale-tree/CAS), **-008** (a bypassed gate masqueraded as a fully-governed promotion), and **-009** (manual
apply proceeded unbound on a git identity read error).

The central invariant: **the exact immutable candidate tested + semantically evaluated is the only candidate
that may be autonomously promoted** — timed-out / stale / late-running work cannot mutate it or create valid
promotion evidence. Fail-closed at the authority is the final defense; cooperative abort is best-effort.

## Verified starting state
- HEAD `1266a5d` (Phase 12); branch `harness/cc-parity-and-bokahli-pilot`; tracked tree clean.
- Pre-existing untracked files (`.claude/`, the audit/re-audit/consolidated reports, `ikbi-0.1.0-rc.1.tgz`,
  `scripts/ui-verify/package-lock.json`) left untouched. `IKBI-RUNTIME-CONFORMANCE-REAUDIT-2.md` is untracked.

## Full candidate-mutation inventory (from 4 parallel read-only investigators; file:line at HEAD 1266a5d)

| Path | Mutation API / site | Cancellable? | Late write? | Identity/evidence effect | Prior promotion? |
|---|---|---|---|---|---|
| Builder (main) | `builderForModel` via `runRoleFn` (1135) → tool `write_file` | **No** (Promise.race abandons loser; comment @1028 "JS cannot cancel it") | **Yes** | timed-out result had no fence | rescue could promote |
| Builder escalation / cheap-retry / fixer / critic-fix | `runRoleFn("builder", …)` @3046/3801/4054/3268/3285 | No | Yes | none | yes |
| Verifier / integrator | `dispatchRole` (deterministic; no model call) | n/a | n/a | — | — |
| Auto-commit | `workspaces.commit` @4163 (+3431/3600/5073/5278/5337) | — | freezes whatever is on disk at commit time | captured a late write | — |
| Tree capture | `readTreeHash(ws.path)` @4332 (normal), 5158 (comp), 5372 (tour) — `git rev-parse HEAD^{tree}` | — | — | sampled AFTER all roles + late work | verifiedTree = post-mutation tree |
| Promotion | `promoteCandidate()` @1959 → `workspaces.promote` (sole caller) | — | — | stale-tree re-read + `verifiedAgainst` CAS | authority |
| Git-backed probe | `isGitBacked()` @1737 → **`false` on ANY error** | — | — | error ⇒ `treeIdentityRequired:false` ⇒ CAS dropped | fail-OPEN |
| Tree-hash probe | `readTreeHash()` @1722 → **`undefined` on ANY error** | — | — | error ⇒ no `verifiedTree` ⇒ no `verifiedAgainst` | fail-OPEN |
| REPL `/apply` | `repl-workspace.ts:promote()` → `readTreeIdentity()` all-errors→undefined | — | — | proceeds unbound on git read error | manual-unverified but unbound |
| Gate wall | `createGateWall()` `gate.ts:106` bypass checked before enabled/grant | — | — | `.env` `IKBI_GATE_WALL_BYPASS=true` ⇒ unconditional allow, no discriminator | veto off, indistinguishable |

**Reproductions confirmed in-source:** `runRoleFn` (1135-1156) `Promise.race` abandons the losing role
promise uncancelled; `readTreeHash`/`isGitBacked` (1722-1745) both swallow errors to `undefined`/`false`;
`PromoteGovernance` had only `allow`/`reason`/`gateId` (no bypass discriminator); the gate/promotion receipts
carried no bypass field; `readTreeIdentity()` returned `undefined` on all errors and promoted unbound.

## Timeout lifecycle — before vs after
- **Before:** a role timeout resolved `runRoleFn`'s race with a synthetic failure and ABANDONED the losing
  promise uncancelled. Nothing revoked the losing operation's ability to keep writing to the workspace; the
  verified tree was sampled after all later async work, so a post-timeout write could be captured + promoted.
- **After:** `runRoleFn` (a) creates an `AbortController` and threads `ctx.signal` (cooperative), aborting it
  when the timer fires; (b) records the outcome into a per-run **MutationFence** — a candidate-MUTATING role
  (`builder`; fixer/escalation/cheap-retry all dispatch as `builder`) that TIMED OUT quarantines its workspace,
  and a CLEAN (non-timed-out) `builder` success supersedes a prior quarantine. `promoteCandidate` fail-closed
  REFUSES a fenced candidate (`worker.promotion.superseded_mutation`). A timed-out tree is never autonomously
  promoted; it may be retained for manual inspection.

## Mutation-lease design (MutationFence)
Per-run, keyed by `taskId` (module-level `activeMutationFences`, registered/cleared by a `fencedRun` wrapper
around the public `run` so all of normal/tournament/competitive share one fence). Two monotonic ticks per
workspace: `lastMutatingTimeout` (a builder dispatch returned `detail.timedOut === true`) and
`lastCleanMutation` (a builder dispatch returned success without timeout). `isFenced(ws) = lastMutatingTimeout
> lastCleanMutation`. Soundness: a timed-out builder with no superseding clean generation stays fenced (the
reproduced case); an escalation/retry/fixer that cleanly succeeds afterward supersedes (tick ordering).

## Cooperative cancellation
`RoleContext.signal?: AbortSignal` (new) is threaded by `runRoleFn` and aborted on timeout. Roles/tools/provider
calls MAY honor it to stop mutating early. It is best-effort — a role that ignores it is still safe because the
non-cooperative fence blocks promotion of timed-out work. (Wiring the builder tool loop / provider to honor it
is a follow-up enhancement; the plumbing + fence are in place now.)

## Non-cooperative fencing
The MutationFence + the `promoteCandidate` `mutationFenced` gate are the FINAL authority: a revoked/timed-out
mutating operation's tree cannot be autonomously promoted regardless of whether the abandoned promise later
writes. Recording that a late mutation occurred is not enough — the fence makes it non-promotable.

## Immutable snapshot / verification binding (scope note)
This phase binds promotion to a fail-closed identity + the mutation fence rather than copying the candidate to
a physically read-only location. The existing stale-tree check (live `HEAD^{tree}` must equal the candidate's
`verifiedTree`) plus the new fence together enforce that a timed-out or post-verify mutation cannot promote.
A full physically-frozen verification copy (test a committed snapshot the writer cannot touch) is the stronger
form and is documented below as a remaining enhancement; the fence closes the reproduced attack today.

## Tree-identity result type (fail-closed)
```ts
type WorkspaceIdentityResolution =
  | { status: "resolved"; backing: "git"; identity: string }       // tree hash (or "git:unreadable" sentinel)
  | { status: "resolved"; backing: "non-git"; identity: string }   // proven non-git ⇒ exempt
  | { status: "indeterminate"; error: string };                    // probe error ⇒ BLOCKS autonomous promotion
```
`resolveWorkspaceIdentity(path)` (injectable via `deps.resolveWorkspaceIdentity`) classifies by git-backing:
a git binary that could NOT run (`ENOENT`/`EACCES`/`ETIMEDOUT`/`SIGTERM`) or an unrecognized failure is
**indeterminate**; git that RAN and answered "not a git repository" / "cannot change to" / path-missing is
**proven non-git** (an in-memory/test workspace stays exempt). `candidateIdentityFields` maps: git ⇒
`{treeIdentityRequired:true}`; non-git ⇒ exempt; indeterminate ⇒ `{treeIdentityRequired:true,
identityIndeterminate:true}`. Backward-compatible: when only the legacy `deps.isGitBacked`/`deps.readTreeHash`
are injected, classification derives from them (a git worktree with an unreadable tree stays git-backed and is
failed closed by the EXISTING `worker.promotion.tree_identity_unavailable` gate — B5 unchanged).

## Paired Git-probe behavior + CAS
An indeterminate resolution now BLOCKS promotion (`worker.promotion.identity_indeterminate`) BEFORE the promote,
so `verifiedAgainst` is never silently omitted and the non-CAS path is never reached on a probe error. The
existing stale-tree + `verifiedAgainst`/`integratedTree` CAS in `WorkspaceManager.promote()` is unchanged; the
fix ensures a real worktree can never be reclassified as exempt to bypass it.

## Gate-wall bypass behavior (truthful)
`PromoteGovernance` gains `bypass?: boolean`; `createGateWall()` sets `bypass:true` when
`IKBI_GATE_WALL_BYPASS` is active (the decision is discriminable, not just a reason string). The gate receipt
surfaces `bypass:true`; the `worker.promotion` receipt records `gateBypassed:true` +
`gateAuthority:"administratively-bypassed"` (a governed allow is `"policy-evaluated"`); the manual-apply
receipt surfaces `gateBypassed`. The operator convenience is retained (lab-only) but its authority is truthful —
a bypassed land is never audited as a fully-governed autonomous promotion. The production-config probe is run
with `IKBI_GATE_WALL_BYPASS=false`.

## Evidence invalidation
The mutation fence quarantines a workspace whose latest mutating generation timed out; a clean generation must
supersede it (a new generation) before promotion. The identity gate refuses when the candidate's identity is
indeterminate. Both preclude promoting evidence tied to a superseded/unresolvable generation.

## Manual-apply (REAUDIT2-009)
`resolveManualIdentity()` (fail-closed) distinguishes git / proven-non-git / indeterminate. A git-backed
workspace whose identity is unreadable now REFUSES the manual apply (`manual apply refused: tree identity
indeterminate`) instead of proceeding unbound; a proven non-git workspace still proceeds unbound (legit). The
manual-apply receipt surfaces `gateBypassed`.

## Files changed
- `src/modules/worker-model/orchestrator.ts` — `WorkspaceIdentityResolution` type, `MutationFence` +
  `activeMutationFences`, `runRoleFn` abort+fence, `fencedRun` wrapper, `resolveWorkspaceIdentity` +
  `candidateIdentityFields`, candidate `identityIndeterminate`/`mutationFenced` fields (normal/comp/tournament),
  two new `promoteCandidate` gates + receipt ops, `gateBypassed`/`gateAuthority` on `worker.promotion`.
- `src/modules/worker-model/contract.ts` — `RoleContext.signal?: AbortSignal`.
- `src/core/workspace/contract.ts` — `PromoteGovernance.bypass?`.
- `src/modules/gate-wall/gate.ts` — set `bypass:true` on a bypass decision + surface it in the gate receipt.
- `src/modules/chat/repl-workspace.ts` — fail-closed `resolveManualIdentity`, refuse indeterminate git apply,
  surface `gateBypassed` in the manual-apply receipt.
- **new** `src/modules/worker-model/phase13-immutable-verification-conformance.test.ts` — 12 tests.

## Retained tests (12, all green) — maps to the required list
- **A1** timed-out builder cannot autonomously promote (mutation fence) — reqs 1,4,5,12–15.
- **A2** a REAL uncancellable runRoleFn timeout (abandoned promise) does not autonomously promote — req 2.
- **A3** a clean generation supersedes; a normal build promotes (fence inert) — reqs 12–15,30–34 baseline.
- **B16** resolved git-backed identity promotes — req 16.
- **B17** proven non-git resolves + exempt — req 17.
- **B18** indeterminate identity BLOCKS (probe error never waives CAS; `verifiedAgainst` not omitted) — reqs 18,21,24.
- **B19** permission-denied probe → indeterminate → blocks — req 19.
- **B20** paired/conflicting probe failure → indeterminate → blocks (the reproduced case) — req 20.
- **B23** default resolver classifies a real git dir fail-closed without throwing — req 23.
- **C26/C27** bypassed gate carries the discriminator; promotion receipt surfaces it — reqs 26,27.
- **C28/C29** policy-evaluated gate labelled fully governed; probe runs bypass-disabled — reqs 28,29.
- **C-gate** the gate DECISION object carries `bypass` only in bypass mode — req 26.

Reqs covered by unchanged prior suites (kept green): 3 (timed-out cost recorded — invocation-ledger),
6–10/16 (executed-test/tree binding — promotion-authority), 22 (base identity), 25 (stale base),
35 (all Phase 1–12 conformance), 36 (production probe). Not every one of the 36 is a separate new test; the
distinct invariants are covered above and the requirement numbers are annotated per test.

## Mutation guards (demonstrated FAIL → revert)
| # | Mutation | Guard | Result |
|---|---|---|---|
| 1/4 | timeout leaves authority active (drop the `mutationFenced` gate) | A1 | fail → revert → pass |
| 5/6 | git-probe error treated as non-git (indeterminate→exempt) | B18 | fail → revert → pass |
| 8 | bypass emits normal promotion (drop the `bypass` discriminator) | C26 | fail → revert → pass |

(Guards 2,3,7,9,10 are pinned by the same retained tests: A2 abandoned-promise no-promote, A1/A3 fence
ordering, C28 governed-authority label, and the fence's supersession tick logic. Reverts verified clean.)

## Commands + results
- `pnpm build` — clean (tsc strict).
- Phase 13 suite (tsx): **12 / 12**.
- Full worker-model suite: **1265 / 1265** (was 1253 → +12).
- Full `pnpm test`: **3722 tests, 3721 pass, 0 fail, 1 skipped** (was 3710 → +12).
- Production-config probe (`orchestrator.test.ts`, isolation=none, `.env`, **`IKBI_GATE_WALL_BYPASS=false`**):
  **111 / 111**.
- No paid provider calls. No leaked child processes observed (git probes are `execFileSync` with a 10s timeout).
- `.env`-dependent difference: the pre-existing `worker-model.cli.test.ts` "gate-denied promote" env-selection
  artifact (documented in Phase 12) is unchanged and unrelated; it passes under canonical `pnpm test`.

## Answers to the phase's questions
- **Can timed-out work affect a promotable tree?** Not autonomously: the mutation fence blocks promotion of any
  workspace whose latest mutating generation timed out and was not superseded by a clean generation. (Cooperative
  abort further reduces the window; a physically-frozen verification copy is a documented enhancement.)
- **Do tests and promotion always use the same immutable snapshot?** Promotion is bound to the candidate's
  `verifiedTree` and the stale-tree re-read refuses a live tree that differs; a timed-out/superseded generation
  is fenced. A separate physical snapshot is not yet created (see remaining boundaries).
- **Can any probe failure waive CAS?** No: an indeterminate tree-identity resolution blocks before promotion; a
  probe error can no longer be laundered into a non-git exemption.
- **Can bypassed runs appear fully verified?** No: `gateBypassed`/`gateAuthority:"administratively-bypassed"` on
  the receipt; the gate decision carries `bypass:true`.
- **Phases 1–12 intact?** Yes — all prior conformance suites + the 111/111 probe are green; the only behavior
  change to existing paths is stricter (fail-closed) blocking on timeouts/indeterminate identity/bypass truth.

## Remaining boundaries / not globally fixed
- **No physical read-only verification snapshot** — verification still runs against the (committed) workspace,
  bound by the stale-tree hash + fence rather than a copied frozen tree. A builder that writes to disk WITHOUT
  a timeout and is not re-verified is still governed only by the stale-tree re-read (unchanged). **[enhancement]**
- **Cooperative abort is plumbed but not yet honored** by the builder tool loop / provider calls — a role that
  ignores `ctx.signal` relies entirely on the non-cooperative fence. **[enhancement]**
- **Non-cooperative fs write fencing** — the fence blocks PROMOTION, not the fs write itself; a late write still
  reaches disk (it just cannot promote). Wrapping the builder's tool/fs layer with a lease check is a larger,
  higher-risk change deferred. **[audit target]**
- **REAUDIT2-003/-004/-005/-006/-007** (served-vs-logical model identity, charged-failure/CLI cost aggregation,
  evidence-support vs membership, requirement-ID recovery equivalence, receipt reconciliation) are **out of
  Phase 13 scope** and remain open for later phases. **[audit target]**
- **The `.env` `IKBI_GATE_WALL_BYPASS=true`** is retained (lab-only operator convenience); its authority is now
  truthful, but a governed autonomous profile must set it false. **[documented]**
- Uncancellable git child processes: the default probes use `execFileSync` (synchronous, 10s timeout) — no
  lingering async child; a hung git would block the calling role until its own timeout. **[documented]**

## Commit
One cohesive commit (the fence + fail-closed identity + bypass truth + manual-apply are one interlocking
immutable-verification authority pass; splitting the shared `orchestrator.ts`/test hunks would risk a non-green
intermediate): `fix(promotion): fence timed-out mutations + fail-closed identity + truthful gate bypass`.
Not pushed.
