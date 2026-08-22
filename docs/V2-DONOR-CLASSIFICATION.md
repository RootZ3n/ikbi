# ikbi v2 — V1 Donor Classification (advisory)

Produced during **V2-001** (canonical lifecycle foundation) and updated by **V2-002**
(provider + profile configuration boundary), **V2-003** (single model-resolution
authority), **V2-003A** (provider inventory truth) **V2-004** (canonical context
authority) **V2-005** (canonical model invocation authority) **V2-006** (workspace + state-bound
mutation authority), **V2-006A** (canonical source snapshot authority), **V2-006B**
(deterministic snapshot-bound retrieval), **V2-007** (canonical builder + governed tool
loop), **V2-007A** (untrusted tool-result neutralization), **V2-008** (canonical
verification authority), **V2-009** (canonical critic / intent-alignment
authority), **V2-010** (canonical disposition / adjudication authority), **V2-011**
(canonical promotion / publication authority), **V2-012** (canonical recovery controller +
attempt ledger) and **V2-013** (semantic repair as fresh-attempt evidence). This is an **advisory input to future work
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
| Provider auto-discovery | `core/provider/index.ts` `autoDiscoverProviders` | **ADOPT as FACTS, REPLACE as mechanism** *(V2-003A)* | The *mapping* (provider → the model a credential makes available) is good and correct, and v2 adopts it verbatim as a declarative fact table. The *mechanism* is not: it runs after the built-ins are upserted and skips any model already present (`index.ts:99`), so a preference-named entry SUPPRESSES the genuine route. Reproduced end to end — with an OpenAI credential, `IKBI_MODEL_DRIVER=gpt-4o` made `gpt-4o` disappear from v2's inventory entirely. v2 evaluates the facts itself against provider readiness and never depends on v1's construction order. |
| Operator model configuration (`IKBI_MODEL_*`, `config.provider.defaultModels`) | `src/core/config.ts` | **REFINE** *(V2-002)* | Correct as a source; wrong as an authority. v1 lets any call site read it independently (`role-models.ts` is a thin wrapper over the singleton). v2 captures it ONCE into `RuntimeModelPolicy` as the `operator_env` / `builtin_default` precedence layers, so no later v2 code has a reason to reread it. The three-tier vocabulary (`driver`/`builder`/`critic`) is normalized onto named roles by an explicit table. |
| Tier presets (`--tier cheap/mid/frontier`) | `worker-model/tier-presets.ts` | **PARK → future policy INPUT** *(V2-002, re-confirmed V2-003)* | A pure, well-documented lookup that pins builder+critic and decides whether auto-escalation may fire. It is **not** a competing configuration authority today (a per-run flag consumed by `worker-model/cli.ts`), so it needs no v2 change yet. When migrated it becomes a named preset feeding `RuntimeModelPolicy` — a precedence layer beside a profile — and must never regain an independent resolver path. Guarded. Its escalation flag is recovery policy, not configuration and not resolution. |
| Model capability classification | `core/provider/capabilities.ts` | **ADOPT (with provenance)** *(V2-003)* | `getCapabilities` + `isModelClassified` are exactly right, and v2 adopts them. The one refinement: `getCapabilities` always returns a profile, falling back to a conservative 8k/no-tools guess for an unknown id. That guess is a safe way to DRIVE a model, not a fact about it, so v2 publishes capability facts only when they are roster-`declared` or table-`known`, and a requirement against an unclassified model fails rather than being answered from the default. |
| Profiles — the FILE FORMAT and CLI | `src/modules/profiles/` | **ADOPT** *(V2-002)* | The profile document (roles, `extends`, routing, `max_run_cost`) and the `list/show/use/current/init/clear` CLI are sound and are now v2's real input. v2 reads the same files and the same `active-profile` pointer `ikbi profile use` writes; activation stays entirely v1's. |
| Profiles — ACTIVATION SEMANTICS | `src/modules/profiles/storage.ts`, `cli.ts` | **REFINE** *(V2-002, was ADOPT)* | **Downgraded on evidence.** `profile use` wrote the pointer and then printed `export IKBI_MODEL_*` instructions; **no production path read the pointer** — a repo-wide search found no consumer of `getActiveProfile`, `resolveProfile`, or the pointer file outside `src/modules/profiles/` itself. Actual build behavior depended on the operator's shell. Two further defects surfaced while adapting it: `resolveProfile` **silently drops inheritance** when a parent is missing (logs a warning, returns the child unmerged) and returns `undefined` for an over-deep chain (indistinguishable from "not found"); and profile names are not validated as path-safe stems. v2 therefore resolves inheritance in its own adapter (mirroring v1's merge, pinned by an equivalence test) and fails truthfully. **`profileToEnv` is the artifact of the defect** — v2 does not use it and must never mutate the operator's environment. |
| Model router (`resolveModel`, cheapest-sufficient) | `src/modules/model-router/` | **PARK → future resolver STRATEGY** *(V2-003)* | Genuinely wired (expert-rental, consult, recovery, orchestrator). v2 now has a deterministic base resolver with one owner; cheapest-sufficient selection should return later as a STRATEGY invoked *inside* `resolveModelRoute`, never as a second entry point. A static guard now fails the build if any v2 file imports it. |
| Expert rental / MoE | `worker-model/expert-rental.ts` | **PARK → future resolver STRATEGY** *(V2-003)* | Same shape as the router: a selection policy, not a selection authority. Guarded. |
| Luak ranking | `src/modules/model-evaluation/` | **PARK → future resolver STRATEGY** *(V2-003)* | Ranking is an input to a choice, not a way to make one. Guarded. |
| Role models (`driverModel`/`builderModel`/`criticModel`) | `worker-model/role-models.ts` | **REPLACE** *(V2-003)* | A thin wrapper letting any call site read `config.provider.defaultModels` independently — the pattern v2 exists to end. Its *inputs* are captured once into `RuntimeModelPolicy` as the `operator_env`/`builtin_default` layers; the wrapper itself has no v2 successor. Guarded. |
| Built-in registry construction | `core/provider/index.ts:122-189` | **REPLACE** *(V2-003, completed V2-003A)* | **The conflation defect.** `const { driver, critic } = pc.defaultModels` then `{ id: driver, … providerModelId: driver }` means expressing a PREFERENCE mints an inventory entry. Three distinct corruptions were demonstrated end to end: it **invents** a model (`IKBI_MODEL_DRIVER=totally-made-up-model` becomes "available"), it **deletes** one (a preference for an auto-discoverable model suppresses its genuine route), and it **reroutes** one (`IKBI_MODEL_CRITIC=mimo-v2.5` changes `mimo-v2.5` from `[mimo, openrouter]` to `[mimo, deepseek]`). None is recoverable by filtering the merged result, because the merged result no longer records which entries were real. V2-003A therefore stopped reading v1's model map and **composes the catalog from declarative facts** — all six shipped built-ins with their true routes, the auto-discovery fact table, and the operator's declared roster. Guarded against drift by `src/v2/runtime/catalog-drift.test.ts`, which reads v1's source. v1 is unchanged. |
| Workspace isolation (worktrees, allocate/promote/discard, CAS `update-ref`) | `src/core/workspace/` | **ADOPT** | The strongest thing in v1. Crash-durable intent states, pid-owned allocations, ref-level atomic promote, retain-on-signal. v2 should bind `V2WorkspaceId` to it and otherwise leave it alone. |
| **State-bound / hash-anchored mutation** (`file-state.ts`, `mutation.ts`, `mutation-session.ts`, `repair-plan.ts`) | `src/core/workspace/` | **ADOPT (refine the surface)** | Evidence: `observeFileState` reads with `O_NOFOLLOW`, hashes exact bytes, distinguishes missing/empty/regular/directory/symlink; `STALE_MUTATION` is a real compare-and-swap rejection consumed by `repair-plan.ts`; and the session layer is production-wired into `builder.ts`, `tool-executor.ts`, `builder-tools/delegate.ts`, `chat/session.ts`, and `agent-tools/notebook-tools.ts`. This is the capability v2 must *strengthen*, not rebuild. The refinement is convergence: v2 exposes ONE `StateBoundMutationAuthority` (see `src/v2/core/contract.ts`) that every mode — builder, repair, shadow, tournament candidate, REPL — must route through, so no mode can acquire a private write path. |
| Shadow workspace | `src/modules/runtime-truth-shadow/`, tournament shadow replay in `worker-model/tournament.ts` | **PARK (preserve)** | Must survive. It becomes a `CandidateStrategy` in v2, not a parallel spine. Do not touch it until the candidate-strategy slice. |
| Tournament | `src/modules/worker-model/tournament.ts` | **REFINE (preserve)** | The algorithm — N independent candidates, one deterministic judge, winner replayed into a clean shadow, verified again, then the *existing* promote path — is already the right shape and is already careful not to create a second promote path. In v2 it becomes a `CandidateProducer`; verification/disposition/promotion move out of it into the spine. |
| Competitive mode | `worker-model/config.ts` (`IKBI_WORKER_MODEL_COMPETITIVE`, default off) | **PARK** | Overlaps heavily with tournament. Whether it stays a distinct strategy or collapses into tournament width is an architecture decision for the candidate-strategy slice, not now. |
| Deterministic judge | `src/modules/deterministic-judge/` | **ADOPT** | Model-free, pure scoring over objective facts. Exactly what a multi-candidate disposition needs. |
| Builder tools (22 tools) | `worker-model/builder-tools/`, `tool-executor.ts` | **REFINE** | Keep the tool set. The refinement is that every mutating tool must go through the single state-bound mutation authority, and every tool RESULT must keep re-entering through the neutralization chokepoint — enforced by construction rather than by convention. |
| Builder (agent lane + patchsmith lane) | `worker-model/builder.ts`, `patchsmith.ts` | **REFINE** | Becomes a candidate *producer* with no verdict authority. v1 already asserts "the builder is a worker, not a witness"; v2 makes the signature unable to express a verdict. |
| Verifier / check runners / verification ladder | `worker-model/verifier.ts`, `checks.ts`, `src/modules/verification-ladder/` | **ADOPT (single owner)** | The ladder, stub-detection and no-vacuous-green logic are the crown jewels. In v2 there is exactly one verification authority and every candidate — single, shadow, tournament — goes through it. |
| Critic / critic-fix-loop / critic-recovery | `worker-model/critic*.ts` | **REFINE (done V2-009)** | The semantic-judgment capability is now v2's canonical critic — see *Critic systems (V2-009)* below. The judgment posture is ADOPTed; the best-effort PARSER is REPLACEd by a strict one (no naked rejection); the fix/recovery loop and skip-on-red are PARK/REMOVED. |
| Adjudication core | `worker-model/adjudication/` | **ADOPT — the v2 blueprint, realized V2-010** | `WorkProduct` / `ProtocolExit` / `WorkAssessment` / `SafetyAssessment` → one `decidePromotability`, with a signature that *cannot* express a protocol exit, and `treeHash` binding a verdict to the exact tree. V2-010 rebuilds exactly this posture as `src/v2/core/disposition.ts`: one pure `adjudicate` + `judgeDisposition`, a signature that takes evidence + policy and returns a decision (no model, no mutation, no promotion), and identity content-addressed over (candidate/tree, verification, critic, policy, decision, reasons). The v1 core's key ideas are all here — greenness-on-merit, tree-bound verdict, "green work is never discarded" (defects ⇒ withhold, not reject). See *Disposition systems (V2-010)* below. |
| Recovery / retry systems | `src/modules/recovery/`, `worker-model/critic-recovery.ts`, `fix-recovery-lab.ts`, escalation | **REPLACE (done V2-012)** | The ONE recovery authority is now v2's session controller — see *Recovery systems (V2-012)* below. v1's recovery decides a MODEL CASCADE (escalate up the tier ladder); v2's decides whether a FRESH ATTEMPT is lawful, on the SAME frozen policy — no escalation, no fallback. The v1 attempt-ledger + single-terminal-verdict + trust-deferral SHAPE was adopted; the model-selection decision was replaced. |
| Refuter | `worker-model/refuter.ts` | **PARK** | Off by default and correctly optional. It is a safety-evidence contributor; migrate with the disposition slice. |
| Correction library | `src/modules/correction-library/` | **PARK** | Operator-approved lessons, nothing auto-installs. Governance posture is already right; no v2 pressure on it yet. |
| Runtime-truth (evidence) | `src/modules/runtime-truth/` | **REFINE** | Real executed-evidence layer; belongs under the single verification authority rather than beside it. |
| Gate-wall | `src/modules/gate-wall/` | **ADOPT** | A downstream policy authority with a clean boundary. v2 keeps it as the policy owner feeding `withheld` dispositions. |
| Governed exec + sandbox | `src/modules/governed-exec/`, bubblewrap path | **ADOPT** | Allowlist + gate-wall + receipts + OS sandbox, fail-closed off-Linux. No reason to redesign. |
| Trust (earned tiers, MAC-protected) | `src/core/trust/` | **ADOPT** | Fail-closed, MAC-protected, floor-by-default. Feeds v2's `policy` failure category unchanged. |
| Identity (claim / verified peer / validated) | `src/core/identity/` | **ADOPT** | The claim-vs-validated posture is exactly what v2's `V2TaskRequest` → `V2Task` boundary imitates. |
| Promotion | `worker-model/integrator.ts` + `workspace.promote` CAS | **REFINE (done V2-011)** | The publication MECHANICS are now v2's canonical promotion authority — see *Promotion systems (V2-011)* below. V2-011 reuses the donor CAS/worktree-sync PRIMITIVES (`updateRefCas`, `commitTree`, `syncWorktreeToRef`) but NOT `WorkspaceManager.promote` itself (which auto-merges — forbidden) and NOT the integrator (already REPLACED). The disposition decides eligibility; promotion enacts it, from the spine only, landing exactly the candidate tree. |
| Integrator (orchestration blob) | `worker-model/integrator.ts` | **REPLACE (done V2-010)** | 274 lines that re-decide promotability by reaching into role-result detail bags (`filesWritten`, `policyViolations`, `testEvidence`, prevented-attempt thresholds, refuter) — a second adjudication path beside `decidePromotability`, coupled to `RoleFn`/`ctx.task`/`workerModelConfig`. v2 keeps the QUESTION and throws away the blob: `disposition.ts` reads only the three canonical evidence records + one explicit policy, and a guard forbids any v2 import of `worker-model/integrator`. The prevented-attempt / risk-threshold logic is safety-evidence for the disposition/recovery slices, not adjudication core. |
| Receipts | `src/core/receipt/` | **REFINE** | Durable, attributed, ordered, append-only — keep. The refinement is truth-by-construction: v2 receipts must be *counted* from a lifecycle ledger (as `summarizeEvidence` already does) rather than assembled by callers. |
| Cost accounting | `worker-model` costing + budget caps | **PARK** | Needs `V2InvocationId` to exist first. Migrating cost before invocation identity would reintroduce attribution-by-coincidence. |
| MCP model loop | `src/modules/mcp-model-loop/` | **PARK** | Self-contained and off the golden path. Migrate as a tool-surface slice. |
| REPL mutation path | `src/modules/chat/session.ts` | **REFINE** | Already uses the mutation-session layer — good. It must converge on the same v2 mutation authority as the builder, so "the REPL edits files differently from a build" stops being possible. |
| CLI command registrar | `src/cli/registry.ts` | **ADOPT** | v2 registers through it today. A genuinely good seam. |

## Context systems *(V2-004)*

**What a v1 builder actually receives**, established by reading prompt construction
(`worker-model/builder.ts:1076-1094`) rather than documentation. In order: a trusted
system prompt carrying a PRIMARY TARGETS addendum built from paths named in the goal
(`builder.ts:797-824`); then untrusted blocks for project instructions
(`loadProjectMemory`), a multi-step team hand-off, gbrain recall, runtime-truth
evidence, the goal, the success condition, and prior role results — which is where the
model-driven scout's brief arrives. **No context-packet, project-index or
project-retrieval output reaches the builder prompt directly.**

| v1 system | Production reachability | Contributes | Verdict |
| --- | --- | --- | --- |
| `loadProjectMemory` | **YES** — `builder.ts:1041` | CLAUDE.md/AGENTS.md (first wins) + IKBI.md + `.ikbi/project.md`/`checks.yaml`/`ignore`, concatenated, 16KB per file | **ADOPT (refined)** — deterministic, read-only, bounded, never throws. v2 adopts the file set, the first-present-wins rule and the byte cap, but emits ONE ARTIFACT PER FILE so each carries its own path and observed digest, and adds symlink/traversal confinement v1 does not have. |
| Goal-named target files (`extractTargetFiles`) | **YES** — `builder.ts:1052` | path-shaped tokens from the goal, extension-filtered, capped at 10, named to the builder as PRIMARY TARGETS | **ADOPT (refined)** — v2 reuses the selection rules and additionally READS and digests the files. One correction: v1's regex cannot capture a leading `/`, so `/etc/passwd.ts` reaches its filter as a relative path; v2 matches the slash and declines to call an absolute path a target. |
| `context-preflight` | **YES** — `orchestrator.ts:101` | a chars/4 estimate of base prompt size, used to pre-emptively escalate to a bigger window | **ADOPT as SEMANTICS** — v2 adopts the chars/4 heuristic and the constant, and LABELS every token number `estimated`. The escalation decision itself is recovery policy, not context. |
| `context-layer` | **YES** — `builder.ts:71` | deterministic in-loop compression once a conversation grows | **PARK** — mid-conversation compaction. There is no conversation until invocation exists. |
| `context-manager` | **YES** — `builder.ts:70` | model-produced summarisation of the middle of a conversation | **PARK — invokes a model.** Out of scope by construction for a read-only slice, and it belongs to the invocation loop, not to initial assembly. |
| Scout context gathering | **YES** — the scout role | a model-written brief that carries retrieval results into `builder_prior_results` | **PARK — invokes a model.** This is the only path by which retrieval currently reaches a builder. A future builder strategy may request model-driven exploration through the canonical invocation path; it must not hide a model call inside "context". |
| `project-retrieval` | **INDIRECT** — scout (index mode) + `consult` | deterministic, model-free relevance ranking over the index | **RESOLVED IN V2-006B — see below.** |
| `project-index` | **INDIRECT** — verification-ladder, repo-doctor, project-retrieval | repository structure/graph | **RESOLVED IN V2-006B — see below.** |
| `context-packets` | **NO** — no production consumer (only a doc-comment reference in `consult/codeSlice.ts`) | repo map + file previews | **PARK — dormant.** Nothing calls it. Migrating it would be adopting a second retrieval system on the strength of its existing, which is the habit v2 exists to break. |
| `lab-context-memory` / `labmem-recall` | **YES**, but not to the builder — cognition-layer, drift-prevention, capability-recovery | cross-agent memory | **PARK** — speculative/global memory with unbounded relevance. Not imported into v2 context. |
| gbrain recall | **OPT-IN**, default off (`IKBI_GBRAIN_CONTEXT`) — `builder.ts:1046` | external knowledge, injected beside project instructions | **PARK** — spawns an external process and is off by default. |
| Team hand-off brief | **YES** — `builder.ts:1083` | prior steps' summary in a multi-step build | **PARK** — belongs to the step-planner, which v2 has not reached. |
| Runtime-truth evidence | **YES** — `builder.ts:1089` | executed-evidence block | **PARK** — belongs to verification, which v2 has not reached. |

## Invocation systems *(V2-005)*

| v1 system | Production reachability | Contributes | Verdict |
| --- | --- | --- | --- |
| OpenAI-compatible + Anthropic HTTP transports | **YES** | protocol, auth headers, SSE parsing, response validation, timeout, typed `ProviderError` | **ADOPT** — mature and single-shot. Audited: one `fetchImpl` call per `invoke` (`openai-compatible.ts:438`), no internal retry. v2 calls `provider.invoke` directly through a narrow adapter. |
| `ProviderInvoker.invokeModel` | **YES** — the whole v1 build path | registry route lookup, ORDERED FALLBACK across `spec.providers`, circuit breakers, same-route retry | **REPLACE for v2 (preserve for v1)** — this is *routing*, and routing already happened at V2-003. Fallback, retry and escalation are recovery decisions; v2's invocation authority bypasses it entirely and a static guard fails the build if any v2 file calls `invokeModel`. |
| `ProviderError` taxonomy | **YES** | timeout / http / network / auth / rate_limit / bad_response / config | **ADOPT** — mapped onto v2 codes rather than collapsed, including the 4xx-vs-5xx split. |
| `TokenUsage` accounting | **YES** | prompt/completion/total/cached tokens as the provider reported them | **ADOPT** — carried verbatim; absent fields stay absent rather than becoming zeroes. |
| **Served model identity** | **WAS DISCARDED** — both transports parsed the response and dropped `parsed.model` | nothing | **REFINE (the one v1 change)** — `ProviderResult.servedModelId` added as an additive optional field and populated in both transports. Without it a caller can only restate what it sent and call that attribution. Inert in v1; nothing there reads it. |
| Streaming (`invokeStream`, SSE) | **YES** — the builder loop | incremental deltas | **PARK** — this slice makes one complete request. Streaming belongs with the conversation loop. |
| Circuit breakers | **YES** — inside `ProviderInvoker` | per-route failure suppression | **PARK** — a recovery concern, and inseparable from the routing it guards. |

## Workspace + mutation systems *(V2-006)*

| v1 system | Production reachability | Verdict |
| --- | --- | --- |
| `WorkspaceManager.allocate` | **YES** — every build | **ADOPT** — cross-process allocation lock, bound enforcement, pid-owned records, crash reaping. v2 adds a run binding and the exact base COMMIT+TREE (a branch name is not a binding). |
| `WorkspaceManager.discard` / `retain` | **YES** | **ADOPT** — v2 wraps both so a cleanup that does not finish is reported `failed`, never silently as if it had. |
| `WorkspaceManager.promote` (ref-level CAS `update-ref`) | **YES** | **PARK — not called by v2.** Genuinely careful, and still parked: promotion is its own authority in a later slice, and reaching for it here would create the second promote path v2 exists to prevent. A static guard fails the build on `.promote(` anywhere in v2. |
| Crash-durable intent (`allocating`/`promoting`, `ownerPid`, SIGINT/SIGTERM retain) | **YES** | **ADOPT as-is** — v2 inherits it by using the donor manager. v2 adds only that its own runs discard on the normal stop. |
| `file-state.ts` `observeFileState` | **YES** | **ADOPT** — opens with `O_NOFOLLOW`, hashes exact bytes, distinguishes missing/empty/regular/directory/symlink, and re-stats through the descriptor. Exactly the observation v2 needs. |
| `mutation.ts` (the state-bound CORE) | **YES** — managed candidates | **ADOPT — the strongest donor in the codebase.** Observations live in the core's PRIVATE table (a caller cannot alter the expected bytes); `apply` takes a cross-process lock, re-reads, and compares raw byte identity before writing; writes go through `atomicWriteFile`; paths are normalized, the root re-`realpath`ed, and every existing parent component checked for symlinks. v2 adds a run binding, a workspace-scoped content-addressed observation id, and structured failures. |
| `mutation-session.ts` | **YES** — builder/chat text tools | **PARK** — a useful session/observation-cache layer over the core, but v2's authority is the core itself. Migrate when a builder needs session-scoped observation reuse. |
| `repair-plan.ts` | **YES** — repair paths | **PARK** — already state-bound (it consumes `STALE_MUTATION`); belongs to the recovery slice. |
| Builder/chat mutation integration (`tool-executor.ts`) | **YES** | **REFINE** — routes managed-candidate text tools through the session, and `builder.ts:977` states plainly that "an isolated candidate must never fall back to the old direct writer". The routing is right; in v2 it becomes "tools receive the mutation authority, never `fs`". |
| **Raw write paths** — `builder-tools/patch.ts:90`, `multi-edit.ts:108`, `delegate.ts:186`, `confine.ts:92`, `agent-tools/notebook-tools.ts:291` | **YES**, for NON-candidate worktrees | **REPLACE for v2 (preserve for v1).** The finding of this recon: these are confined but **not state-bound** — they `writeFileSync` after a path check, with no observation and no compare-and-swap. They are the reason "the donor machinery is wired" cannot be assumed globally. v2 has no equivalent, and a static guard fails the build if any v2 file performs a filesystem write outside the workspace adapter. |

## Source-state systems *(V2-006A)*

| v1 system | Production reachability | Verdict |
| --- | --- | --- |
| `addWorktree` (`git worktree add <path> -b <branch> <baseBranch>`) | **YES** — every build | **ADOPT as the base, EXTEND for source truth.** It checks out the BRANCH TIP, so v1 silently builds against committed state while the operator sees uncommitted work — a build can succeed on code the operator does not have. v2 keeps the worktree as the isolation primitive and materializes the run's source snapshot on top of it. |
| Dirty-source handling | **none** | **REPLACE for v2 (v1 untouched).** v1 has no synchronization, staging, patch generation or copy path for uncommitted work; there is simply nothing there. `syncWorktreeToRef` (`git.ts:318`) stashes INSIDE a worktree, which is a different concern. |
| `git status --porcelain` / `ls-files --others --exclude-standard` | **YES** — diff/summary helpers | **ADOPT as the fact source.** Git already knows which files are tracked, modified, deleted, untracked and ignored. v2 asks it rather than inventing a second opinion about what counts as source. |
| `git show HEAD:<path>` | — | **ADOPT.** Serving unchanged files from the immutable HEAD blob is what makes mid-run source drift structurally impossible rather than merely detected. |

## Retrieval systems *(V2-006B)*

The gap V2-004 left open: with only instructions and goal-named targets as sources, a
task that named no filename gave the model almost no repository evidence. v1 does have
deterministic ranking — but it reaches a builder only through the MODEL-DRIVEN SCOUT, so
adopting it as-is would have hidden a model call inside "context".

| v1 system | Production reachability | Contributes | Verdict |
| --- | --- | --- | --- |
| `project-retrieval` scoring vocabulary (reason→weight table, stable sorts, decision trail) | **INDIRECT** — scout (index mode) + `consult` | an explainable score per file | **ADOPT as SEMANTICS.** v2 keeps the shape — a closed set of named reasons, each with a fixed weight, so a score always decomposes into stated evidence — and keeps the total-order sort. Weights and reason names are v2's own. |
| `goalTokens` query mining + `STOPWORDS` | same | path-shaped tokens and stopworded prose terms from the goal | **ADOPT (refined).** v2 reuses the two-kind split and the stopword idea, and adds three corrections found by testing: identifiers are ALSO split into camel/snake fragments; terms match WHOLE WORDS (v1-style substring search reports a file about "nothing" as evidence for a task about "things"); and a path written in the goal has its text removed before prose is mined, so naming `src/widget.ts` does not make every file under `src/` a directory match. |
| `project-retrieval`'s index INPUT (`projectIndex.refresh(repoPath)`) | same | the file set and graph it ranks over | **REPLACE.** This is the disqualifying coupling: ranking is deterministic, but its input is a live filesystem walk behind a mutable cache, so the same task could rank differently at two moments. v2 ranks over the run's `SourceSnapshot` via a new read-only `list()` seam — HEAD ∪ untracked − deleted − excluded. |
| `project-index` | **INDIRECT** — verification-ladder, repo-doctor, project-retrieval | repository structure/graph, cached | **PARK (preserve).** 991 lines of direct `readdirSync`/`readFileSync`/`statSync` walking (`implementation.ts:211-529`), its own `.gitignore` parsing and a persisted cache with no snapshot binding. Real and used by v1; adopting it would reintroduce the mutable-source reread V2-006A removed. v2 derives the little structure it needs — import edges, colocated tests — from snapshot bytes, per run, with no cache. |
| Scout context gathering | **YES** — the scout role | a model-written brief carrying retrieval into `builder_prior_results` | **STILL PARKED — invokes a model.** V2-006B removes the *reason* it was the only retrieval path; a future builder strategy may still request model-driven exploration, through the canonical invocation path. |
| `context-packets` | **NO** — no production consumer | repo map + file previews | **STILL PARKED — dormant.** v2 now has one retrieval authority; adopting a second on the strength of its existing is the habit v2 exists to break. |

**The division of labour, stated once.** RETRIEVAL DISCOVERS; THE CONTEXT AUTHORITY
ADMITS. `rankFiles` proposes at most `maxCandidates` files with reasons; `assembleContext`
decides what actually fits, in the lowest priority band, and records every omission. A
retrieved file never displaces one the operator named, and a file a higher band already
carries is never paid for twice.

## Builder systems *(V2-007)*

v1's builder (`worker-model/builder.ts`, 2327 lines) is the most capable thing in the
donor codebase and also the most entangled: the model+tool loop is interleaved with
recovery policy, check interpretation, stall detection and completion rescue, all bound to
the v1 orchestrator's `RoleFn`/`OperationContext`. The loop MECHANICS are worth learning
from; the POLICY is a set of authorities v2 has not established yet.

| v1 system | Production reachability | Verdict |
| --- | --- | --- |
| The model+tool loop shape (send → tool_calls → execute → append result → repeat, bounded) | **YES** — every build | **ADOPT as SHAPE, REBUILD.** v2's controller is ~120 lines because it is *only* the loop. v1's is 2327 because it is the loop plus everything listed below. |
| Bounded iteration (`MAX_TOOL_ITERATIONS`, default 40, `IKBI_MAX_TOOL_ITERATIONS`) | **YES** | **ADOPT as PRINCIPLE, tighter.** v2 bounds turns, tool calls AND mutations, all as hard structured failures. The default is deliberately small (12 turns) while there is no recovery authority to grow it against. |
| AUTO-ACCEPT on green checks (`builder.ts`, the protocol-termination rescue) | **YES** | **PARK — it is a RECOVERY authority in disguise.** A loop that ran out of iterations consults the last `run_checks` result and, if green, synthesizes the `done` the model never emitted. That is a completion decision made by the builder on the strength of a verification v2 has not built. v2 fails instead. |
| Stall / stuck / no-progress detection, bare-stop nudges | **YES** | **PARTIALLY ADOPTED.** The bare-stop NUDGE is adopted (a prose completion is answered with "call the finish tool"); stall and no-progress classification are parked — they are recovery signals, and v2 has nothing to hand them to. |
| The neutralization CHOKEPOINT (`appendToolResult` is the only path from a tool result to a message) | **YES** | **ADOPT as SHAPE.** v2's controller has exactly one such function for exactly this reason. The v1 chokepoint additionally routes through `neutralizeUntrusted`; v2's does not yet, and that is a stated gap — repository content re-enters the model at one place, so adding it is a change to one function rather than a dozen. |
| Text-protocol tool emulation (`builder-tools/text-tool-protocol.ts`) | **YES** — for no-tool-API models | **PARK — REFUSED for v2.** Parsing tool intent out of markdown can execute a "call" the model never made. v2 uses provider-native `tool_calls` only; a route without them is a capability fact about the route, not a reason for a weaker second protocol. Guarded. |
| Normalized `ToolCall` + `ModelMessage.toolCalls` / `toolCallId` (`core/provider/contract.ts`) | **YES** | **ADOPT VERBATIM.** The donor contract already round-trips a full tool loop and both transports already serialize and parse it. v2 carries it across unchanged — this is the one place where reusing v1 is strictly better than rebuilding. |
| `tool-executor.ts` (shared builder+chat dispatch) | **YES** | **PARK.** Genuinely good governance work (the memory-governor chokepoint), but it dispatches v1's 22-tool set including raw `writeConfinedFile` paths, and it is bound to `OperationContext`. v2 has its own four-verb executor over the state-bound authority. |
| `WorkspaceMutationSession` / `mutation-session.ts` | **YES** — builder + chat | **PARK; the CORE beneath it is ADOPTED.** V2-006 already adopted `core/workspace/mutation.ts` (observe → CAS → atomic write), which is the part that matters. The session layer adds v1-shaped tool errors and batching v2 does not need. |
| `patch` / `multi_edit` | **YES** | **PARK.** Both express a partial edit, which makes "the state I am replacing" ambiguous. v2's replace takes the COMPLETE resulting bytes, which is what makes the compare-and-swap meaningful. They can return later expressed as complete-content mutations. |
| `terminal` + `governed-exec` (allowlist, gate-wall, receipts) | **YES** | **PARK — deliberately, and it is the notable omission.** A coding builder ultimately needs command execution, and governed-exec is mature. But a shell is a write path: `sed -i`, `echo >`, `git checkout <path>` and any script all mutate files outside `StateBoundMutationAuthority`, which would silently void this slice's central invariant. Exposing a "read-only subset" means proving a command cannot write, which is a slice of work in itself. Guarded until then. |
| `delegate_task`, MCP, web/vision tools, `brain_*`, git tools | **YES** | **PARK.** Each is capability rather than correctness, and `delegate` additionally invokes a model outside the one invocation doorway. |
| `context-manager` (model-produced conversation summarisation) | **YES** — `builder.ts:70` | **PARK — invokes a model.** A second, hidden model call inside the builder loop. v2 fails with `build.context_exhausted` rather than quietly summarising; compaction returns when it can be a declared, budgeted authority. |
| `context-layer` (deterministic in-loop compression) | **YES** | **PARK.** Deterministic and therefore adoptable later, but unnecessary while turns are bounded at 12. |
| Streaming (`invokeStream`, `ToolCallDelta`) | **YES** | **PARK.** Real and useful for operator experience; it changes nothing about what is sent or what comes back, and a partial tool call must never execute. |
| `done` self-check + substance validation | **YES** | **ADOPT as PRINCIPLE, simplified.** v1 validates the `done` claim for substance and rejects rubber-stamps. v2 keeps the ESSENTIAL half — finishing requires an explicit tool call, and prose is not a finish — but records the claim rather than judging it, because judging it is verification's job. |
| Workspace lifecycle (`builder.ts` never promotes or discards) | **YES** | **ADOPT.** v1's builder writes files and nothing else; lifecycle is the orchestrator's. v2 keeps exactly that separation: the controller cannot allocate, retain, discard or promote. |

## Verification systems *(V2-008)*

v1's verifier (`worker-model/verifier.ts`, 1265 lines) is where deterministic checking,
repair coupling, the escalation ladder, script-integrity guarding and promotion adjacency
all live together. V2-008 keeps the deterministic CHECKING and throws away the coupling.

| v1 system | Production reachability | Verdict |
| --- | --- | --- |
| `checks.ts` — `resolveChecks` / `parseChecksEnv` / project-root guard | **YES** — every verify | **ADOPT (refined behind a seam).** The strongest deterministic check DISCOVERY in the codebase: operator `IKBI_CHECKS` (never model-chosen, never read from the worktree) or a recognized manifest (pnpm/npm/yarn, cargo, go, pytest/unittest, dotnet, maven, gradle, godot), fail-closed with a reason — never a vacuous pass — and an ANCESTOR-manifest guard so a nested worktree cannot run the wrong repo's suite. `runtime/verification-checks.ts` wraps it. |
| `governed-exec` (allowlist + gate-wall + F1 OS sandbox + receipts) | **YES** — every check | **ADOPT (behind a seam).** Verification commands run through the SAME execution authority as everything else — default-deny allowlist, worktree-writable/host-read-only sandbox, network-deny, `verifier: true` for package scripts (a flag a model cannot set). `runtime/check-runner.ts` mints a self-contained deterministic-system identity (its own one-agent registry + fresh token — it borrows no operator credential) and maps `ExecResult` → `CheckExecution`. The model never reaches it. |
| `checks.ts` — `mapExec` / `CheckResult` / `resolveCheckTimeoutMs` / `DEFAULT_CHECK_TIMEOUT_MS` | **YES** | **ADOPT as SEMANTICS.** The timeout knob (`IKBI_CHECK_TIMEOUT_MS`), the 124 timeout-kill exit code, the bounded output tail, and the exit-code → status mapping. v2 does NOT adopt `parseTestCount`/vacuous-green gating — that is a critic concern, not deterministic verification. |
| `verifier.ts` — the loop, the script-integrity diff guard, the ladder, DRY-RUN handling | **YES** | **REPLACE.** 1265 lines coupled to `RoleFn`/`OperationContext`, a diff-based script guard, and a promotion-adjacent verdict. v2's verifier is ~200 pure lines: subject binding, two tree rechecks, plan, run-all, classify. The script guard is subsumed by the AFTER tree recheck — a check that rewrites anything (package.json included) changes the tree and is caught, without parsing a diff. |
| `verifier.ts` — corrections / fixer-on-verifier-fail / dual-model escalation | **YES** | **PARK.** A failed verification ENDS the run in v2. Repair, builder re-entry and escalation are a recovery authority that does not exist yet — establishing verification TRUTH first is the point of the slice. |
| `verification-ladder` | **YES** — multi-package | **PARK.** Per-package ladder over the same governed path. v2 verifies ONE candidate's ONE tree. |
| `deterministic-judge` / `quality-checks` / `semantic-*` | **YES** | **PARK — critic-adjacent.** These interpret check results into a promote/withhold judgement; that is V2-009's critic/disposition authority. |
| `check-triage` | **YES** | **PARK.** Parses failures into repair hypotheses for the fixer — a recovery input. v2 records bounded output for a future critic through the untrusted-data discipline (V2-007A); it feeds no model here. |

**The load-bearing v2 additions v1 has no equivalent of:** the candidate is IDENTITY-BOUND
(a `VerificationSubject` refuses a foreign run/candidate/tree/workspace); the tree is
rechecked BEFORE (drift ⇒ no checks run) and AFTER (mutation ⇒ the verdict is invalid
whatever the exit codes); and the `VerificationRecord` is content-addressed over
(candidate, tree, plan, ordered per-check verdicts) — never a timestamp, never the output
text — so it is provably about one candidate and no other.

## Critic systems *(V2-009)*

v1's critic answers a genuine question — does the work materially satisfy the operator's
intent? — but wraps it in machinery that dilutes the answer: a best-effort parser that
downgrades a malformed judgment to `indeterminate` (so a bare "FAIL" becomes a soft
non-answer instead of a protocol error), a fix loop that overlaps recovery, and a
skip-on-red path that lets a failing verification suppress the semantic judgment entirely.
V2-009 keeps exactly the semantic-judgment CAPABILITY and rebuilds its authority: ONE
critic, one strict verdict, defects that must be named, and no second recovery engine.

| v1 system | Production reachability | Verdict |
| --- | --- | --- |
| `worker-model/critic.ts` — the semantic-judgment CAPABILITY (does the candidate satisfy intent, given the checks?) | **YES** — every build's assessment | **REFINE → the v2 blueprint.** The question and its posture (green checks are necessary-not-sufficient; a preference is not a defect) are exactly right and are v2's critic contract. In v2 it is one authority resolved as its OWN model role, judging an immutable review package, holding no tools, deciding nothing about promotion. |
| `worker-model/critic.ts` — the response PARSER (fence-stripping, prose tolerance, downgrade-to-indeterminate) | **YES** | **REPLACE.** The load-bearing v1 defect: a negative judgment with no defect, or an unparseable response, is best-effort-downgraded to a soft verdict. v2's parser is strict — not-JSON, a bare `defects_found`, a plain "FAIL", a `satisfied` that carries a material defect, an unknown category/severity are all HARD protocol failures that STOP the run; they never become evidence. No naked rejection can survive. |
| `worker-model/critic-fix-loop.ts` / `critic-recovery.ts` | **YES** — on adverse critic | **PARK.** A second retry/repair engine beside `src/modules/recovery/`. A critic verdict in v2 is semantic EVIDENCE; acting on it (retry, repair, escalate) is a disposition/recovery authority that does not exist yet. Migrate with the recovery slice, folded into the one recovery policy — never as a critic-owned loop. |
| skip-critic-on-red (verifier RED ⇒ no critic) | **YES** | **REPLACE (removed).** In v2 the critic runs after ANY `VerificationRecord` — PASS, FAIL, NO_CHECKS, TIMEOUT, INFRASTRUCTURE_FAILURE. Deterministic red and a semantic judgment are different evidence; suppressing one because the other is adverse is exactly the coupling V2-009 ends. |
| `worker-model/refuter.ts` / `integrator.ts` | off by default / promote-adjacent | **PARK.** Neither is the semantic critic. The refuter is optional safety evidence (disposition slice); the integrator's CAS promote is spine-only (already classified REFINE above). A static guard fails the build if any v2 file imports a v1 critic, refuter or integrator. |

**The load-bearing v2 additions v1 has no equivalent of:** the critic judges an immutable
`CriticInputPackage`, never the live workspace; its subject BINDS run/task/snapshot/
candidate/tree/verification and rechecks the tree before the call (drift ⇒ `subject_drift`,
no model call); the candidate diff it reads is MODEL-CAUSED only — `startTree`→`candidateTree`,
never `HEAD`→candidate, so the operator's own uncommitted work is never charged to the model;
every untrusted payload (goal, diff, check output, builder claim) crosses the V2-007A
`UntrustedBoundary` while trusted provenance (ids, verdicts, hashes) stays plain; and the
`CriticRecord` is content-addressed over (evidence + verdict + defects) with the invocation
id kept as provenance, never identity — the SAME judgment of the SAME evidence is the SAME
record whichever call produced it.

## Disposition systems *(V2-010)*

v1's promote decision lives in two places that partly overlap: the clean pure
`adjudication/decidePromotability` (the blueprint) and the `integrator.ts` orchestration
blob that re-derives the same judgement from role-result detail bags. V2-010 keeps the
QUESTION — "given this candidate, this deterministic verdict, this semantic verdict and
this explicit policy, what is the lawful disposition?" — and gives it ONE owner.

| v1 system | Production reachability | Verdict |
| --- | --- | --- |
| `adjudication/core.ts` — `decidePromotability` (pure, total, tree-bound) | **YES** — the authoritative decision | **ADOPT (rebuilt as `disposition.ts`).** Same posture: deterministic greenness assessed first, a signature that cannot express a protocol exit, verdict bound to the exact tree, and "green work is never discarded" (a defect ⇒ withhold, not reject). v2 generalizes promote/retain/discard into `acceptable_for_promotion / withhold / reject / quarantine`, adds an explicit content-addressed `DispositionPolicy`, and binds the decision to the three canonical evidence records. |
| `adjudication/contract.ts` — `WorkAssessment.treeHash` / `SafetyAssessment` monotone vetoes | **YES** | **ADOPT as SEMANTICS.** The tree-hash binding is the model for the V2-010 subject re-probe (drift ⇒ quarantine over a stale subject). The safety vetoes are an ADDITIONAL evidence source the disposition input is designed to accept later (a refuter, V2-011+) WITHOUT becoming a second critic — no source overrides another. |
| `integrator.ts` — the promote/discard ORCHESTRATION | **YES** — every build | **REPLACE.** A second adjudication path that reaches into `builderDetail.filesWritten` / `policyViolations` / `testEvidence`, applies prevented-attempt review thresholds, and consults the refuter — all coupled to `RoleFn`/`ctx.task`/`workerModelConfig`. v2's disposition reads ONLY the `CandidateRecord`, `VerificationRecord`, `CriticRecord` and one `DispositionPolicy`. A guard forbids any v2 import of `worker-model/integrator`. |
| `integrator.ts` — prevented-attempt risk thresholds / review escalation | **YES** | **PARK → safety-evidence for V2-011.** Real signal, wrong home. It is recovery/operator-review policy, not the promote decision; it returns as a safety-evidence contributor to the disposition input, never as adjudication logic. |
| skip-critic-on-red / promote-adjacent verdict coupling | **YES** | **REPLACE (removed).** In v2 the critic already runs after every verdict (V2-009) and the disposition weighs both classes explicitly; there is no place where one evidence source silently overrides another. |
| `workspace.promote` CAS + `integrator` enactment | **YES** | **PARK → V2-012.** The disposition AUTHORIZES eligibility; it never moves a ref. The mechanical publication (CAS promote, enacted only by the spine from a disposition) is the next slice. A guard fails the build if the disposition module contains any promote/merge/commit/ref-move. |

**The load-bearing v2 additions v1 has no equivalent of:** the disposition is PURE (no
model, no mutation, no check re-run, no promotion, no repair — the invocation count is
unchanged from builder+critic); it binds an immutable `DispositionSubject`
(run/task/snapshot/candidate/tree/verification/critic/policy) and refuses incoherent
evidence outright (`subject_mismatch` ⇒ the run fails); it RE-PROBES the tree at its own
authority boundary (drift ⇒ quarantine over a stale subject, never an ordinary decision, and
never an auto-reverify); the policy is an explicit content-addressed input, so the SAME
evidence under a DIFFERENT policy is a DIFFERENT disposition identity; the secondary flags
(`eligibleForPromotion` / `requiresRecovery` / `requiresOperator`) are DERIVED from the one
decision, so an impossible combination cannot be constructed; and `acceptable_for_promotion`
is reported as `withheld (awaiting_promotion)` — an ELIGIBILITY fact that changes no ref.

## Promotion systems *(V2-011)*

v1's `WorkspaceManager.promote` is a careful crash-durable CAS — but it also AUTO-MERGES a
moved target (computing a new integrated tree the verifier never saw) and requires a governed
`PromoteApproval`. V2-011 keeps the safe PRIMITIVES and the crash-durable posture, drops the
auto-merge, and makes publication the enactment of an already-authorized disposition — never a
second decision.

| v1 system | Production reachability | Verdict |
| --- | --- | --- |
| `updateRefCas` (atomic compare-and-swap ref move) | **YES** — the one target mutation | **ADOPT.** The single load-bearing primitive. v2's `runtime/publication.ts` reuses it verbatim: `beforeRef → candidate commit`, old-sha guarded, so a concurrent target move fails the CAS. No force, no retry against a new head. |
| `commitTree` (build a commit from a tree + parents) | **YES** | **ADOPT.** v2 materializes the candidate COMMIT mechanically: `commit(tree=candidate.treeId, parent=authorized base)`, verifies the built tree == the candidate tree BEFORE any ref move, and only then CASes. The commit's sha/timestamp/message are provenance — never candidate identity. |
| `syncWorktreeToRef` + `worktreeForBranch` + `isWorktreeClean` (target-worktree sync) | **YES** | **ADOPT.** A clean checked-out target is brought forward to the landed commit AFTER the CAS (stashing any late work, never clobbering it). A sync failure AFTER the ref moved is a DEGRADED SUCCESS, not an ordinary failure. |
| `verifiedAgainst` (targetHead + integratedTree binding) | **YES** | **ADOPT as SEMANTICS.** v1 binds the verdict to the exact tree/head. v2 generalizes it: the promotion SUBJECT binds run/candidate/tree/snapshot/verification/critic/disposition/policy + `eligibleForPromotion`, and rechecks the live target head == the authorized base and the retained workspace tree == the candidate tree at the promotion boundary. |
| dirty checked-out target refusal | **YES** | **ADOPT as a SAFETY FLOOR.** v1 refuses to move a ref under a dirty checked-out target. v2 does too — AND additionally refuses to publish a dirty *source snapshot* at all (clean-ref CAS would fold the operator's pre-existing uncommitted work into an ikbi commit): `refused_dirty_source_unsupported`, terminal `withheld`, nothing touched. |
| auto-merge (`computeMerge` on a moved target) | **YES** | **REPLACE (removed for this slice).** v2 has NO verification record for a newly-merged tree against a moved target, so a merge would land unverified bytes. A moved target is `refused_stale_target` → `withheld`; re-capture/rebuild/re-verify is recovery's job (V2-012+). The `computeMerge` primitive is PARKED until an integrated tree can be independently verified. |
| crash-durable promoting intent + landed record | **YES** | **ADOPT (lightweight).** v2's publication adapter writes an `intent` marker before the CAS and a `landed` marker after — enough for a future recovery to reconcile a crash from the git ref state. It does not rebuild v1's full reconcile engine; that folds into the recovery slice. |
| `PROMOTED_BUT_RECEIPT_FAILED` (degraded success) | **YES** | **ADOPT.** The exact distinction v2 is built around: if the ref moved but post-CAS bookkeeping (worktree sync, journal) did not complete, the result is `promoted_degraded` / terminal `accepted` with `degraded=true` — NEVER reported as if nothing happened. |
| `PromoteApproval` / governance gate | **YES** | **REPLACE.** v2 receives no free-floating `approved` boolean: `promoteAuthorized` proves authorization FROM the `DispositionRecord` (`eligibleForPromotion && decision === acceptable_for_promotion`). Governance re-enters later as a disposition-policy input, not a promote-time flag. |
| `integrator.ts` | **YES** | **REPLACE (unchanged from V2-010).** Still not imported by any v2 file. Promotion reads the four canonical records; it does not re-derive anything from role-result detail bags. |

**The load-bearing v2 additions v1 has no equivalent of:** promotion is MECHANICAL and
re-adjudicates nothing (the invocation count is unchanged from builder+critic — no model, no
critic re-run, no verifier re-run, no repair); it refuses every unsafe condition (not-eligible,
wrong-evidence, dirty-source, candidate-drift, stale-target, dirty-target-worktree, CAS-race)
WITHOUT touching git; it lands EXACTLY `candidate.treeId` by a clean-ref CAS (verified before
AND after the ref move); it is IDEMPOTENT (a target already holding the candidate tree is
`already_promoted`, no second commit); the `PromotionRecord` identity binds what was AUTHORIZED
+ what LANDED (candidate tree, disposition, target branch, published tree — the commit sha is
provenance); and ONLY an actually-landed publication turns `withheld` into `accepted{promotionId}`.

## Operator receipt-log systems *(post-cutover repair)*

Promotion by direct clean-ref CAS was the right call for the REF and it quietly took the
operator's tools with it. `ikbi undo` and `ikbi inspect` read exactly one durable source — the
receipt log — and the only thing that ever wrote a `workspace.promote` entry was
`WorkspaceManager.promote`, which v2 deliberately does not use. So a canonical `ikbi build` could
land a commit on `main` while `ikbi inspect <run-id>` answered `INSPECT_NOT_FOUND` and
`ikbi undo --latest` answered "no revertible promotion found in the receipt log". Measured, not
theorised: a clean fixture build published, and neither command could see it.

A build that cannot be undone is not a daily driver, so the engine records what it did.

| v1 system | Production reachability | Verdict |
| --- | --- | --- |
| `receipts` store singleton (`core/receipt/index.js`) | **YES** — the one durable operator log | **ADOPT (dynamic).** `runtime/run-receipt.ts` resolves it lazily, for the same reason `productionTransport` resolves the provider registry that way: constructing it reads operator configuration, and no command should pay for a store it may never write to. |
| `ReceiptInput` / `ReceiptChange` (`core/receipt/contract.js`) | **YES** | **ADOPT as VOCABULARY.** The `workspace.promote` shape is not a v2 preference — `src/cli/undo.ts` parses `changes[]` for a `state` change with `before.ref`, `after.ref` and a `<repo>#<branch>` target. A receipt in any other shape is one that command cannot use. |
| `AgentIdentity` (`core/identity/contract.js`) | **YES** | **ADOPT.** Receipts are attributed, never anonymous. Both entries are attributed to the ENGINE (`ikbi-v2`) rather than to whichever model wrote the candidate — publication is a governed decision the model never made. |
| `WorkspaceManager.promote`'s own receipt emission | **YES** | **REPLACE (unchanged from V2-011).** v2 still does not call it: it auto-merges and demands an approval the promotion authority does not use. v2 writes the receipt itself, AFTER the run, from the returned session record. |

**Where it runs, and why not in the publication adapter:** the recorder is invoked from the one
production build call site once the session is complete. The publication journal seam is
synchronous, so a receipt appended there would have to be fire-and-forget and would race the
process exit that follows it. Nothing in the recorder can influence what was published; it only
writes down what already happened.

**Honest about durability:** the git ref remains the authoritative landing proof. A receipt that
could not be written is REPORTED — to the caller and to the operator on stderr — and never allowed
to turn a publication that already landed into a failure. Only a ref that actually MOVED is
recorded as revertible: a withheld, conflicted, or idempotent-no-op run writes no promote entry,
because offering an undo for a change that never happened is worse than offering none.

## Recovery systems *(V2-012)*

v1 has retry logic in at least four places — a model-cascade escalation core
(`src/modules/recovery/`), a critic-fix loop, a verifier-driven fix loop, and provider
transport fallback — each able to try again on its own. That diffuse retry is exactly what v2
eliminates: ONE authority decides, after a COMPLETE attempt, whether a FRESH attempt is lawful,
and nothing else may try again.

| v1 system | What it retries | Verdict |
| --- | --- | --- |
| `src/modules/recovery/` (`decideRecovery` + `runRecovery` driver) | escalates to the NEXT model up the tier ladder | **REPLACE (shape adopted).** The decision AXIS is wrong for v2 — it selects a model, which v2 forbids in recovery (no escalation, no fallback). But its ATTEMPT-LEDGER, single-terminal-verdict and trust-deferral posture are the right design, and v2's `AttemptLedger` + one `decideRecovery` generalize them. v2's recovery decides retry-vs-stop on the SAME frozen policy. |
| `worker-model/critic-fix-loop.ts` | re-runs the builder with the critic's feedback as a fix goal | **REPLACE (done V2-013).** The CAPABILITY — a failure teaching the next build — is now v2's semantic repair (see *Semantic repair (V2-013)* below). But the MECHANICS are inverted: v1 reuses the workspace IN-PLACE, folds fix prose INTO the goal ("fix the fix"), and re-runs verify/critic on the mutated workspace. v2 extracts a bounded, identity-bound, NEUTRALIZED `RepairBrief` from the FAILED attempt's evidence and starts a whole FRESH attempt (new RunId/snapshot/workspace/candidate). A guard still forbids any v2 import of the v1 loop. |
| `worker-model/critic-recovery.ts` / `fix-recovery-lab.ts` / `fix*.ts` | fixer passes on a failed candidate | **PARK.** Same reason — semantic repair. Not in this slice. |
| verifier-driven iterative loop (`runIterativeLoop`) | re-runs the builder on RED checks | **REPLACE.** A verification `fail` in v2 is `stop_rejected`; there is no builder re-entry. Objective-red repair folds into the semantic-repair extension. |
| provider transport fallback / retry (`ProviderInvoker`, `invoke-retry`) | a different provider / a second HTTP attempt | **REPLACE (removed).** v2's `InvocationAuthority` is already single-shot (V2-005). A transient provider failure is handled by RECOVERY making a NEW ATTEMPT on the SAME frozen policy — never a provider swap, never an in-authority retry. Proven: the invocation authority makes ONE call; the second attempt is the controller's. |
| prevented-attempt risk thresholds (`integrator.ts`) | (holds a build for review) | **PARK.** Future safety-evidence / operator gate, not recovery. |
| promotion crash reconcile intent | reconciles a crashed promote | **ADOPT/REFINE as deterministic evidence.** v2's `classifyPublicationLanding` reads git ref/tree state as authoritative (journal is optional corroboration, NEVER required) and returns `not_landed` / `landed_exact` / `landed_degraded` / `ambiguous` — no mutation. `promoted_degraded` is `reconciliation_required`, NEVER re-published. |

**The load-bearing v2 additions v1 has no equivalent of:** `ONE RUN = ONE SOURCE SNAPSHOT` is
preserved — a recovery that needs fresh repository state does NOT recapture inside a RunId; it
starts a NEW ATTEMPT with a new RunId and a new snapshot under one `BuildSession`. NO candidate,
verification, critic, disposition, promotion, observation or mutation crosses the boundary. The
retry is authorized ONLY by `decideRecovery` (only environmental triggers, only while budget
remains); an adverse judgment (verification fail, critic defects) is never retried; a dirty
source requires an operator (no endless recapture); a degraded landing is reconciliation, not a
re-publish; and configuration is FROZEN at session start (a later attempt re-reads no profile or
env). The invocation authority stays single-shot — the SECOND attempt exists because recovery
authorized it, not because a lower subsystem quietly tried again.

*(V2-013 note: the environmental-retry "adverse judgments are never retried" clause is now
qualified — a CONCRETE adverse judgment may earn ONE semantic-REPAIR attempt, still a fresh
attempt authorized only by `decideRecovery`. See below.)*

## Semantic repair (V2-013)

The one thing v1's critic-fix loop got right — a failure can teach the next build — v2 keeps,
but rebuilt so it cannot become an in-place fix loop. A failed candidate is HISTORY; a repair is
a NEW ATTEMPT that carries only bounded, neutralized EVIDENCE about what went wrong.

| v1 system | Mechanics | Verdict |
| --- | --- | --- |
| `critic-fix-loop.ts` — `formatValidatedFixGoal` / `formatCriticFixGoal` | turns validated defects into a builder fix GOAL (prose) | **REFINE (the idea) → REPLACE (the shape).** v2 does not fold fix prose into the task ("fix the fix"). It extracts a structured `RepairBrief` (defect ids/categories/severities/paths + bounded check output) presented as a DISTINCT, lower-priority, untrusted historical block — the original task is unchanged. |
| `critic-fix-loop.ts` — the loop (`builder`→`verifier`→`critic` re-run in place) | reuses the SAME workspace; re-verifies/re-critiques the mutated tree | **REPLACE.** v2 makes a FRESH attempt: new RunId, new source snapshot, new workspace, new candidate — the prior candidate is never mutated or resurrected, and the whole pipeline re-runs independently. |
| `critic-recovery.ts` / `fix-recovery-lab.ts` / `fix*.ts` | fixer passes | **PARK.** Still not adopted; the semantic-repair capability is now the `RepairBrief` path. |
| `correction-library` | operator-approved cross-run memory | **PARK.** Deliberately NOT auto-wired — the `RepairBrief` is run-local historical evidence only, never a global memory. |
| provider transient classification (`f.retryable` fallback) | — | **HARDENED (V2-012 audit cutover).** The former `TRANSIENT_PROVIDER_CODES.has(code) \|\| f.retryable` is now the CLOSED code set ALONE — a provider failure is transient iff its code is explicitly recognized, never because a boolean was set upstream. |

**The load-bearing v2 additions v1 has no equivalent of:** the `RepairBrief` is the ONLY thing
that crosses the attempt boundary — bounded (checks/defects/excerpts capped, truncation
recorded), identity-bound (content-addressed over the source attempt + its failure evidence +
the trigger), and NEUTRALIZED (every free-text payload is fenced through the V2-007A boundary;
trusted provenance — ids, verdict enums, statuses — stays plain). It holds NO workspace pointer,
NO observation id, NO mutation id, NO candidate bytes, so no prior authority is actionable in the
new attempt. Only `decideRecovery` authorizes a semantic repair (a CONCRETE `verification_failed`
or `critic_defects`, never `no_checks` or `critic_indeterminate` — nothing to repair — and never
a malformed critic — a protocol failure); the budget is bounded (`maxSemanticRepairAttempts`,
default 1); the model policy is FROZEN (no escalation, no fallback, no profile switch); current
source truth outranks the stale repair text; and a semantic repair interrupted by an
environmental fault KEEPS the same brief IDENTITY (evidence reuse) while still getting a fresh
run/snapshot/workspace (never authority reuse).

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
6. **Retrieval never admits.** *(V2-006B)* Relevance ranking lives in
   `src/v2/core/retrieval.ts` and nowhere else; the context source that carries its
   output may not sort, re-score or mint an identity, and may not enumerate source by
   any means other than `SourceSnapshotReader.list()`. Retrieval introduces no model
   call — the production skeleton still performs exactly one invocation.
7. **Verification is bound to ONE candidate tree.** *(V2-008)* The verifier recomputes
   the candidate tree before checks (drift ⇒ no checks) and after (mutation-by-checks ⇒
   invalid), and `VerificationRecord` is content-addressed over the candidate tree, the
   plan and the ordered per-check verdicts. `NO_CHECKS` is never coerced to `PASS`, a
   timeout/infrastructure failure is never an ordinary fail, and a failed verification
   ends the run — no critic, no repair, no builder re-entry. Deterministic only: no model
   is invoked, and the verifier neither mutates nor calls the invocation authority.
8. **The builder is not an authority over infrastructure.** *(V2-007)* It may reason,
   inspect, request tools and finish. It may not select a model, choose a provider, create
   a workspace, write a file, invoke a provider, verify itself, promote, or retry itself.
   Enforced structurally: `core/builder.ts` imports no `node:` module and no resolver
   call; `runtime/builder-tools.ts` imports no filesystem API; every effect is a
   `StateBoundMutationAuthority.mutate`, and every model turn an `invokeAuthorized`.
9. **No observation, no write.** *(V2-007)* Every builder write names the observation that
   authorized it — creation included. There is no path-only create/replace/delete anywhere
   in v2, and a refused write is reported to the MODEL rather than retried by
   infrastructure.
10. **A candidate is the work, not the event.** *(V2-007)* Candidate identity is a content
   address over (source snapshot, resulting tree). The run, workspace, model, turn count
   and mutation sequence are provenance on the record — all of them can differ while the
   work is identical, and a tournament has to be able to see that.
11. **Inventory is not preference.** *(V2-003, enforced V2-003A)* Nothing an operator
   PREFERS may add, rename, reroute, remove, or suppress a model. Enforced structurally:
   `buildCanonicalCatalog`'s input type has no field a preference fits into, and the
   catalog module imports nothing that could supply one. Only the roster, the provider
   set, a credential genuinely appearing/disappearing, or real capability data may move
   `inventoryDigest`.
12. **No raw context downstream.** *(V2-004)* Anything that will face a model receives a
   `ContextPackage`, never a context source, a repository file, or an ad-hoc string. One
   assembler admits; every omission and truncation is recorded; nothing overflows
   silently.
13. **Selection and invocation are different authorities.** *(V2-005)* The resolver says
   which route is authorized; the invocation authority sends exactly that route, once,
   and records what actually served it. No fallback, no retry, no second resolution. The
   four identities — requested, authorized, sent, served — are never collapsed, and
   `served` is only ever read from the provider's own response.
14. **One workspace authority, one mutation authority.** *(V2-006)* No component creates
   its own worktree, and nothing writes a file except through `mutate`, which requires an
   OBSERVATION rather than a path. Observations are workspace-scoped: identical bytes in a
   sibling candidate are not identical authority. A stale observation is refused — never
   merged, overwritten, silently re-observed or retried.
15. **One run, one source snapshot.** *(V2-006A)* Context reads it, the workspace is
   materialized from it, and nothing recaptures — silently or otherwise. Reproducing the
   operator's existing uncommitted work in isolation is MATERIALIZATION, never a model
   mutation, and never counts as one.
16. **Nothing is "done" because it exists.** A migrated subsystem is done when a test
   enters through the canonical v2 entrypoint and proves the subsystem is what ran.
17. **No naked rejection, and no skip-on-red.** *(V2-009)* A negative critic verdict must
   name at least one concrete material defect; a `defects_found` with no material defect, a
   non-JSON response, or a `satisfied` carrying a defect is a HARD protocol failure that
   stops the run — never a downgraded soft verdict. The critic runs after EVERY verification
   verdict; deterministic red does not suppress the semantic judgment. The critic is
   semantic EVIDENCE only: it resolves its own model role, holds no tools, judges an
   immutable review package, and decides nothing about promotion.
18. **No evidence source overrides another, and eligibility is not promotion.** *(V2-010)*
   The disposition weighs the deterministic verification AND the semantic critic against ONE
   explicit content-addressed policy and returns the ONE lawful decision. A red verifier is
   never overridden by a happy critic; a concrete defect is never erased by a passing
   verifier (green work is withheld, not discarded). The authority is PURE — no model, no
   mutation, no check re-run, no promotion, no repair. `acceptable_for_promotion` is an
   AUTHORIZATION fact reported as `withheld (awaiting_promotion)`; it moves no ref. The
   derived flags (`eligibleForPromotion`/`requiresRecovery`/`requiresOperator`) come from the
   one decision, so an impossible combination is unconstructable, and a tree that moved since
   the critic looked is quarantined over a stale subject, never adjudicated.
19. **Promotion enacts; it never decides, merges, or commits operator dirt.** *(V2-011)*
   The publication authority proves authorization FROM the `DispositionRecord` — no free
   `approved` boolean. It re-adjudicates nothing (no model, no critic/verifier re-run, no
   repair), refuses every unsafe condition WITHOUT touching git, and lands EXACTLY the
   candidate tree by a clean-ref CAS (verified before and after the ref move). A MOVED target
   is refused, never auto-merged — an unverified integrated tree must not land. A DIRTY source
   checkout is refused, never silently committed. Publication is IDEMPOTENT (no duplicate
   commit) and crash-durable (intent before the CAS, landed record after). Only an actually
   landed publication turns `withheld` into `accepted`; a ref that moved but whose bookkeeping
   did not finish is a DEGRADED success, never reported as if nothing happened. The target ref
   is moved by exactly ONE adapter (`runtime/publication.ts`); no other v2 code calls
   `update-ref` or the v1 auto-merging `WorkspaceManager.promote`.
20. **One recovery authority; a retry is a fresh attempt, never a quiet re-try.** *(V2-012)*
   `ONE RUN = ONE SOURCE SNAPSHOT` holds — recovery never recaptures inside a RunId; it starts a
   NEW ATTEMPT (new RunId, new snapshot, whole new evidence chain) under one `BuildSession`. Only
   `decideRecovery` authorizes a new attempt, and only for an ENVIRONMENTAL trigger (moved
   target, CAS conflict, candidate drift, verification timeout/infrastructure failure, transient
   provider failure) while budget remains. An adverse JUDGMENT (verification fail, critic
   defects) is NEVER retried — there is no semantic repair, no critic-fix loop, no verifier
   re-run, no builder re-entry. There is no model escalation, no provider fallback, no profile
   switch; the invocation authority stays single-shot and the session freezes configuration at
   its start. NO evidence crosses the attempt boundary. A `promoted_degraded` landing is
   `reconciliation_required`, NEVER re-published; git ref/tree state is authoritative over any
   journal, which is never required. *(V2-013 qualifies the "adverse judgment is never retried"
   clause: a CONCRETE adverse judgment may earn ONE semantic-repair attempt — see #21.)*
21. **Semantic repair is a fresh attempt with neutralized evidence, never an in-place fix.**
   *(V2-013)* A failed candidate is HISTORY. When a CONCRETE adverse judgment (verification FAIL
   or critic DEFECTS_FOUND) occurs, `decideRecovery` — and only it — may authorize ONE
   semantic-repair attempt. That attempt is a genuinely new run (new RunId, snapshot, workspace,
   candidate) that independently rebuilds, verifies, criticizes, adjudicates and publishes. The
   ONLY thing carried forward is a bounded, identity-bound, NEUTRALIZED `RepairBrief`: it holds no
   workspace/observation/mutation handle and no candidate bytes, and every free-text payload is
   fenced through the untrusted boundary. `no_checks`, `critic_indeterminate` and a malformed
   critic are NEVER repaired. The model policy is frozen (no escalation/fallback/profile switch),
   the repair budget is bounded (default 1), current source truth outranks the repair text, and
   the correction library is never auto-wired. Evidence reuse across a repair lineage is not
   authority reuse — no stale candidate/observation/verification/critic/disposition/promotion
   crosses the boundary.
