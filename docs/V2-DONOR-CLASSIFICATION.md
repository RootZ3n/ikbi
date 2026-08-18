# ikbi v2 — V1 Donor Classification (advisory)

Produced during **V2-001** (canonical lifecycle foundation) and updated by **V2-002**
(provider + profile configuration boundary) and **V2-003** (single model-resolution
authority). This is an **advisory input to future work
orders**, not a change plan and not permission to delete anything. Nothing in v1 was
removed, disabled, or altered to produce it.

Rows revised by a later slice are marked with the slice that revised them.

## What the four verdicts mean

| Verdict | Meaning |
| --- | --- |
| **ADOPT** | The v1 implementation is sound and production-proven. Bring it across largely intact; it may need only an import boundary. |
| **REFINE** | The capability and most of the code are right, but the *authority* or the API shape must change to fit one canonical owner in v2. |
| **REPLACE** | The capability must survive; this particular implementation should not be carried forward as-is. |
| **PARK** | Leave running in v1. Do not migrate yet — its v2 slice comes later, and migrating early would force premature contracts. |

**Preserve capability ≠ preserve implementation.** No entry below is a proposal to
drop a feature. In particular, **shadow workspace and tournament are explicitly
preserved** and the v2 lifecycle was designed around them (see "Candidate strategy").

## Classification

| v1 system | Where | Verdict | Why |
| --- | --- | --- | --- |
| Provider transports (`anthropic.ts`, `openai-compatible.ts`, `sse-parse.ts`) | `src/core/provider/providers/` | **ADOPT** | Narrow, well-tested I/O adapters with no authority of their own. Two transports + an SSE parser is exactly the right surface; nothing about v2 changes what an HTTP call to a model looks like. |
| Provider registry / capabilities / preflight / circuit-breaker | `src/core/provider/` | **REFINE** *(V2-002 confirmed)* | The mechanism is good, but "model identity" in v2 must be resolved once, by one owner, and carried as a `V2InvocationId`-bearing record. v1 resolves capability in several places (`capabilities.ts` classification gaps are a known source of silent degradation). Keep the code, put one resolver in front of it. **V2-002 finding:** `ProviderPreflightInfo` is excellent — non-secret, no I/O, and exactly the right shape for a truthful inventory; v2 adopts it verbatim. Two gaps: the registry does **not retain per-model route provenance** (built-in default vs roster file vs key-triggered auto-discovery are merged into one map by `buildDefaultRegistry`), and the singleton **constructs every transport at module import** and requires the egress guard to be installed first — which is why v2 imports it dynamically. |
| Provider auto-discovery | `core/provider/index.ts` `autoDiscoverProviders` | **REFINE** *(V2-002)* | Adding a model route because an API key exists is convenient and is why key-only setups work. But it means the roster silently changes shape with the environment, and the resulting route is indistinguishable from a declared one. v2 records the resulting models truthfully; a later slice should make the origin explicit rather than removing the convenience. |
| Operator model configuration (`IKBI_MODEL_*`, `config.provider.defaultModels`) | `src/core/config.ts` | **REFINE** *(V2-002)* | Correct as a source; wrong as an authority. v1 lets any call site read it independently (`role-models.ts` is a thin wrapper over the singleton). v2 captures it ONCE into `RuntimeModelPolicy` as the `operator_env` / `builtin_default` precedence layers, so no later v2 code has a reason to reread it. The three-tier vocabulary (`driver`/`builder`/`critic`) is normalized onto named roles by an explicit table. |
| Tier presets (`--tier cheap/mid/frontier`) | `worker-model/tier-presets.ts` | **PARK → future policy INPUT** *(V2-002, re-confirmed V2-003)* | A pure, well-documented lookup that pins builder+critic and decides whether auto-escalation may fire. It is **not** a competing configuration authority today (a per-run flag consumed by `worker-model/cli.ts`), so it needs no v2 change yet. When migrated it becomes a named preset feeding `RuntimeModelPolicy` — a precedence layer beside a profile — and must never regain an independent resolver path. Guarded. Its escalation flag is recovery policy, not configuration and not resolution. |
| Model capability classification | `core/provider/capabilities.ts` | **ADOPT (with provenance)** *(V2-003)* | `getCapabilities` + `isModelClassified` are exactly right, and v2 adopts them. The one refinement: `getCapabilities` always returns a profile, falling back to a conservative 8k/no-tools guess for an unknown id. That guess is a safe way to DRIVE a model, not a fact about it, so v2 publishes capability facts only when they are roster-`declared` or table-`known`, and a requirement against an unclassified model fails rather than being answered from the default. |
| Profiles — the FILE FORMAT and CLI | `src/modules/profiles/` | **ADOPT** *(V2-002)* | The profile document (roles, `extends`, routing, `max_run_cost`) and the `list/show/use/current/init/clear` CLI are sound and are now v2's real input. v2 reads the same files and the same `active-profile` pointer `ikbi profile use` writes; activation stays entirely v1's. |
| Profiles — ACTIVATION SEMANTICS | `src/modules/profiles/storage.ts`, `cli.ts` | **REFINE** *(V2-002, was ADOPT)* | **Downgraded on evidence.** `profile use` wrote the pointer and then printed `export IKBI_MODEL_*` instructions; **no production path read the pointer** — a repo-wide search found no consumer of `getActiveProfile`, `resolveProfile`, or the pointer file outside `src/modules/profiles/` itself. Actual build behavior depended on the operator's shell. Two further defects surfaced while adapting it: `resolveProfile` **silently drops inheritance** when a parent is missing (logs a warning, returns the child unmerged) and returns `undefined` for an over-deep chain (indistinguishable from "not found"); and profile names are not validated as path-safe stems. v2 therefore resolves inheritance in its own adapter (mirroring v1's merge, pinned by an equivalence test) and fails truthfully. **`profileToEnv` is the artifact of the defect** — v2 does not use it and must never mutate the operator's environment. |
| Model router (`resolveModel`, cheapest-sufficient) | `src/modules/model-router/` | **PARK → future resolver STRATEGY** *(V2-003)* | Genuinely wired (expert-rental, consult, recovery, orchestrator). v2 now has a deterministic base resolver with one owner; cheapest-sufficient selection should return later as a STRATEGY invoked *inside* `resolveModelRoute`, never as a second entry point. A static guard now fails the build if any v2 file imports it. |
| Expert rental / MoE | `worker-model/expert-rental.ts` | **PARK → future resolver STRATEGY** *(V2-003)* | Same shape as the router: a selection policy, not a selection authority. Guarded. |
| Luak ranking | `src/modules/model-evaluation/` | **PARK → future resolver STRATEGY** *(V2-003)* | Ranking is an input to a choice, not a way to make one. Guarded. |
| Role models (`driverModel`/`builderModel`/`criticModel`) | `worker-model/role-models.ts` | **REPLACE** *(V2-003)* | A thin wrapper letting any call site read `config.provider.defaultModels` independently — the pattern v2 exists to end. Its *inputs* are captured once into `RuntimeModelPolicy` as the `operator_env`/`builtin_default` layers; the wrapper itself has no v2 successor. Guarded. |
| Built-in registry construction | `core/provider/index.ts:122-148` | **REPLACE** *(V2-003)* | **The conflation defect.** `const { driver, critic } = pc.defaultModels` then `{ id: driver, … providerModelId: driver }` means expressing a PREFERENCE mints an inventory entry. Demonstrated end to end: `IKBI_MODEL_DRIVER=totally-made-up-model` makes a model that exists nowhere "available" and moves the inventory digest; pointing it at something real DELETES `mimo-v2.5`. v2 does not inherit it — see `src/v2/runtime/model-catalog.ts`. v1 is unchanged. |
| Workspace isolation (worktrees, allocate/promote/discard, CAS `update-ref`) | `src/core/workspace/` | **ADOPT** | The strongest thing in v1. Crash-durable intent states, pid-owned allocations, ref-level atomic promote, retain-on-signal. v2 should bind `V2WorkspaceId` to it and otherwise leave it alone. |
| **State-bound / hash-anchored mutation** (`file-state.ts`, `mutation.ts`, `mutation-session.ts`, `repair-plan.ts`) | `src/core/workspace/` | **ADOPT (refine the surface)** | Evidence: `observeFileState` reads with `O_NOFOLLOW`, hashes exact bytes, distinguishes missing/empty/regular/directory/symlink; `STALE_MUTATION` is a real compare-and-swap rejection consumed by `repair-plan.ts`; and the session layer is production-wired into `builder.ts`, `tool-executor.ts`, `builder-tools/delegate.ts`, `chat/session.ts`, and `agent-tools/notebook-tools.ts`. This is the capability v2 must *strengthen*, not rebuild. The refinement is convergence: v2 exposes ONE `StateBoundMutationAuthority` (see `src/v2/core/contract.ts`) that every mode — builder, repair, shadow, tournament candidate, REPL — must route through, so no mode can acquire a private write path. |
| Shadow workspace | `src/modules/runtime-truth-shadow/`, tournament shadow replay in `worker-model/tournament.ts` | **PARK (preserve)** | Must survive. It becomes a `CandidateStrategy` in v2, not a parallel spine. Do not touch it until the candidate-strategy slice. |
| Tournament | `src/modules/worker-model/tournament.ts` | **REFINE (preserve)** | The algorithm — N independent candidates, one deterministic judge, winner replayed into a clean shadow, verified again, then the *existing* promote path — is already the right shape and is already careful not to create a second promote path. In v2 it becomes a `CandidateProducer`; verification/disposition/promotion move out of it into the spine. |
| Competitive mode | `worker-model/config.ts` (`IKBI_WORKER_MODEL_COMPETITIVE`, default off) | **PARK** | Overlaps heavily with tournament. Whether it stays a distinct strategy or collapses into tournament width is an architecture decision for the candidate-strategy slice, not now. |
| Deterministic judge | `src/modules/deterministic-judge/` | **ADOPT** | Model-free, pure scoring over objective facts. Exactly what a multi-candidate disposition needs. |
| Builder tools (22 tools) | `worker-model/builder-tools/`, `tool-executor.ts` | **REFINE** | Keep the tool set. The refinement is that every mutating tool must go through the single state-bound mutation authority, and every tool RESULT must keep re-entering through the neutralization chokepoint — enforced by construction rather than by convention. |
| Builder (agent lane + patchsmith lane) | `worker-model/builder.ts`, `patchsmith.ts` | **REFINE** | Becomes a candidate *producer* with no verdict authority. v1 already asserts "the builder is a worker, not a witness"; v2 makes the signature unable to express a verdict. |
| Verifier / check runners / verification ladder | `worker-model/verifier.ts`, `checks.ts`, `src/modules/verification-ladder/` | **ADOPT (single owner)** | The ladder, stub-detection and no-vacuous-green logic are the crown jewels. In v2 there is exactly one verification authority and every candidate — single, shadow, tournament — goes through it. |
| Critic / critic-fix-loop / critic-recovery | `worker-model/critic*.ts` | **REFINE** | Keep as a work-fact contributor to disposition. Its retry/fix loop overlaps the recovery system and should not remain a second recovery engine. |
| Adjudication core | `worker-model/adjudication/` | **ADOPT — it is the v2 blueprint** | `WorkProduct` / `ProtocolExit` / `WorkAssessment` / `SafetyAssessment` → one `decidePromotability`, with a signature that *cannot* express a protocol exit, and `treeHash` binding a verdict to the exact tree. v2's `RunTerminalOutcome` and evidence ledger are a direct generalization of it (promote/retain/discard → accepted/withheld/rejected). |
| Recovery / retry systems | `src/modules/recovery/`, `worker-model/critic-recovery.ts`, `fix-recovery-lab.ts`, escalation | **REPLACE (capability preserved)** | Retry policy currently lives in at least three places with different rules. v2 needs one recovery policy reading `RunFailure.retryable` and one attempt ledger. The *decision core* in `src/modules/recovery/` is the best starting point. |
| Refuter | `worker-model/refuter.ts` | **PARK** | Off by default and correctly optional. It is a safety-evidence contributor; migrate with the disposition slice. |
| Correction library | `src/modules/correction-library/` | **PARK** | Operator-approved lessons, nothing auto-installs. Governance posture is already right; no v2 pressure on it yet. |
| Runtime-truth (evidence) | `src/modules/runtime-truth/` | **REFINE** | Real executed-evidence layer; belongs under the single verification authority rather than beside it. |
| Gate-wall | `src/modules/gate-wall/` | **ADOPT** | A downstream policy authority with a clean boundary. v2 keeps it as the policy owner feeding `withheld` dispositions. |
| Governed exec + sandbox | `src/modules/governed-exec/`, bubblewrap path | **ADOPT** | Allowlist + gate-wall + receipts + OS sandbox, fail-closed off-Linux. No reason to redesign. |
| Trust (earned tiers, MAC-protected) | `src/core/trust/` | **ADOPT** | Fail-closed, MAC-protected, floor-by-default. Feeds v2's `policy` failure category unchanged. |
| Identity (claim / verified peer / validated) | `src/core/identity/` | **ADOPT** | The claim-vs-validated posture is exactly what v2's `V2TaskRequest` → `V2Task` boundary imitates. |
| Promotion | `worker-model/integrator.ts` + `workspace.promote` CAS | **REFINE** | The CAS promote itself is ADOPT-grade. What must change is that promotion is *enacted only by the spine*, from a disposition, never called from a mode. |
| Receipts | `src/core/receipt/` | **REFINE** | Durable, attributed, ordered, append-only — keep. The refinement is truth-by-construction: v2 receipts must be *counted* from a lifecycle ledger (as `summarizeEvidence` already does) rather than assembled by callers. |
| Cost accounting | `worker-model` costing + budget caps | **PARK** | Needs `V2InvocationId` to exist first. Migrating cost before invocation identity would reintroduce attribution-by-coincidence. |
| MCP model loop | `src/modules/mcp-model-loop/` | **PARK** | Self-contained and off the golden path. Migrate as a tool-surface slice. |
| REPL mutation path | `src/modules/chat/session.ts` | **REFINE** | Already uses the mutation-session layer — good. It must converge on the same v2 mutation authority as the builder, so "the REPL edits files differently from a build" stops being possible. |
| CLI command registrar | `src/cli/registry.ts` | **ADOPT** | v2 registers through it today. A genuinely good seam. |

## Standing constraints for later slices

1. **No second promote path.** Any strategy that wants to promote must do it by
   producing candidates and letting the spine adjudicate.
2. **No second configuration source.** *(V2-002)* Model decisions read
   `RuntimeModelPolicy` and nothing else — not `process.env`, not `config.provider`,
   not the profile files, not a hard-coded constant. The lifecycle enforces the
   structural half: `model_resolution` cannot be entered until a configuration has been
   recorded by preflight.
3. **No mutation outside the state-bound authority.** A path-only write API must not
   exist in v2 for any mode.
4. **No receipt field that is asserted rather than counted.**
5. **No second model-selection path.** *(V2-003)* `resolveModelRoute` is the only place
   a model/provider route is chosen. Tier presets, expert rental, Luak ranking,
   complexity routing and the cheapest-sufficient router may return as STRATEGIES called
   inside it; none may become an entry point. Static guards in
   `src/v2/core/isolation.test.ts` fail the build on a v2 import of any of them.
6. **Inventory is not preference.** *(V2-003)* Nothing an operator PREFERS may add,
   rename, or remove a model from the inventory. Only the roster, the provider set, or
   real capability data may move `inventoryDigest`.
7. **Nothing is "done" because it exists.** A migrated subsystem is done when a test
   enters through the canonical v2 entrypoint and proves the subsystem is what ran.
