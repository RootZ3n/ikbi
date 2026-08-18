# ikbi v2 — V1 Donor Classification (advisory)

Produced during **V2-001** (canonical lifecycle foundation) and updated by **V2-002**
(provider + profile configuration boundary), **V2-003** (single model-resolution
authority), **V2-003A** (provider inventory truth) **V2-004** (canonical context
authority) **V2-005** (canonical model invocation authority) **V2-006** (workspace + state-bound
mutation authority), **V2-006A** (canonical source snapshot authority), **V2-006B**
(deterministic snapshot-bound retrieval), **V2-007** (canonical builder + governed tool
loop), **V2-007A** (untrusted tool-result neutralization) and **V2-008** (canonical
verification authority). This is an **advisory input to future work
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
