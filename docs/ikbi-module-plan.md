# ikbi — parallel MODULE phase plan

> Analysis + proposal. No module code. The map we execute the parallel phase from.
> Frozen core complete at `9619f94` (provider, injection, identity, substrate,
> receipt, trust, events, workspace + the versioned-contracts surface — all `1.0.0`).

Every module lives in its own `src/modules/<name>/` directory and talks to other
modules and the engine ONLY through frozen-core contracts (pinning target versions
via `assertContractCompatible`). Two builders never edit the same file — the
shared-file risks (config, server routes, CLI) are called out as a pre-req seam
step, because they are the real blockers to true parallelism.

---

## 0. The frozen-core seams each module builds on (recap)

| Contract (`src/core/...`) | Key surface modules consume |
|---|---|
| `provider` | `invokeModel(ModelRequest)`, `ModelProvider`, registry, cost accounting |
| `injection` | `neutralizeUntrusted(content, ctx)`, `toUntrustedMessage()`, `scanForInjection` |
| `identity` | `resolveIdentity`, `ValidatedIdentity`, `OperationContext`, **`TrustTierResolver` seam**, `AgentIdentity` |
| `substrate` | `locks`, `atomicWriteJson`, `readModifyWrite`/`safeUpdate`, `DocumentStore`, `AtomicAppendLog` |
| `receipt` | `receipts.append`, `query`/`agentHistory`/`summarizeAgent` (read-seam), `ReceiptChange` (reversibility hook), retention |
| `trust` | `trust.resolve` (the resolver), `recordFromReceipt`, **`autonomyForTier()` → `{sandboxed, gateLevel, requiresApproval, autoCommit}`**, `operatorReset` |
| `events` | `events.publish`, `subscribe`, `defineEvent`, `IkbiEvent` |
| `workspace` | `workspaces.allocate/commit/diff/promote/discard/reclaim/preload`, **judge seam (`WorkspaceEvaluation`)**, **promote-governance seam (`PromoteGovernance`)** |
| `contracts` | `assertContractCompatible(name, target)`, `checkCompatibility`, `CONTRACT_VERSIONS` |

---

## 1. Dependency graph

```
                        ┌─────────────── integration seams (S) ───────────────┐
                        │ route-registrar · command-registrar · per-module     │
                        │ config convention · dry-run flag · kill-switch event  │
                        └───────────────────────────────────────────────────────┘
                                            │ (unblocks everything below)
   FLOORS                                   ▼
   ┌── network-egress (SSRF) ──┐      ┌── caching/cost ──┐
   │  (provider fetch, all     │      │  (wraps invokeModel)
   │   outbound network)       │      └──────────────────┘
   └───────────┬───────────────┘                │
               │                                 │
               ▼                                 ▼
   WORKER SUBSTRATE: worker-model (scout · builder · critic · verifier · integrator)
        depends on: provider, injection, identity, trust(autonomy), workspace, events, receipts, caching
               │
   ┌───────────┼───────────────────────────────┬───────────────┬──────────────┐
   ▼           ▼                                 ▼               ▼              ▼
 gate-wall  subagent-spawning              mcp→model-loop   dependency-     governed-
 (trust+    (worker-model +                (provider tool-  install         sudo/curl
  workspace  workspace +                    loop + injection (egress +       (egress +
  governance)identity spawnedFrom)          + egress)        gate-wall +     gate-wall +
   │                                                          workspace)      receipts)
   │  lab-context-memory (receipts read-seam + substrate durable + events)
   │        │
   │        ▼
   │   ┌── cognition-layer ──┐   ┌── drift-prevention ──┐
   │   │ (provider + memory  │   │ (memory + workers +  │
   │   │  + workers)         │   │  receipts + events)  │
   │   └─────────────────────┘   └──────────────────────┘
   ▼
 self-observation/monitoring (events subscribe + receipts read)      Peh agent (provider + identity + injection)
                                                                     dry-run/plan-only (cross-cutting; consumes S)
                                                                     graceful-degradation/kill-switch (cross-cutting; consumes S)
```

Edges that matter:
- **worker-model** is the hub: spawning, gate-wall (interacts), monitoring (observes), drift, cognition all sit downstream of it.
- **gate-wall** consumes `trust.autonomyForTier()` and PRODUCES the `PromoteGovernance` that `workspace.promote` requires — it is the enforcement seam workspace/sudo/dep-install call into.
- **lab-context-memory** consumes the receipt read-seam and persists ITS OWN projections (receipts are ≤30-day ephemeral — recorded constraint). cognition + drift read memory, so memory precedes them.
- **network-egress** is the security floor every outbound-network module routes through (MCP servers, package fetch, governed curl, Peh web-fetch, and ideally the provider's own HTTP).

---

## 2. Build order

**Step S — integration seams (CC solo, sequential, small).** Before any parallel
module touches `config.ts` / `server` / `cli`, define: a route-registrar (modules
export a router; the server composes), a command-registrar (CLI composes module
commands), a per-module config convention (each module reads its own `IKBI_*` so
`config.ts` stops being a write-bottleneck), and the dry-run + kill-switch seams
(see open decisions #3/#4). This is the unlock for true parallelism.

**Step F — floors (2 builders, parallel).**
- `network-egress` (SSRF floor) — **3-eyes**.
- `caching/cost` — **2-eyes**.

**Step W — worker substrate (mostly one builder).** `worker-model`. Most-depended-on;
define the worker contract/orchestrator first, then the five roles can split into
exclusive files (`scout.ts`, `builder.ts`, `critic.ts`, `verifier.ts`,
`integrator.ts`) for internal parallelism. **3-eyes** (orchestrates untrusted
content + spawns work).

**Step P1 — parallel against workers + floors (up to ~6 builders).**
- `gate-wall` — 3-eyes
- `mcp→model-loop` — 3-eyes
- `dependency-install` — 3-eyes
- `governed-sudo/curl` — 3-eyes
- `subagent-spawning` — 3-eyes
- `lab-context-memory` — 2-eyes
- `peh-agent` — 2-eyes
- `self-observation/monitoring` — 2-eyes

**Step P2 — depends on P1 (parallel).**
- `cognition-layer` (needs memory) — 2-eyes
- `drift-prevention` (needs memory + workers) — 2-eyes
- `dry-run/plan-only` (cross-cutting; build once the S-seam exists + the side-effecting modules it gates) — 2-eyes
- `graceful-degradation/kill-switch` (cross-cutting; late — needs the modules it halts; consumes the S kill-switch seam) — 3-eyes

---

## 3. Parallelization map (exclusive files)

Each module owns `src/modules/<name>/`. They communicate only through frozen-core
contracts → no shared module files. The **only** shared-file collisions are
cross-cutting engine files, resolved by Step S:

| Shared file | Risk | Resolution (Step S) |
|---|---|---|
| `src/core/config.ts` | every module adds `IKBI_*` → write-collision | **per-module config convention** (each `src/modules/<x>/config.ts` reads its own env); freeze `core/config.ts` to core only |
| `src/server/index.ts` | every endpoint-exposing module (self-obs status, Peh Q&A, dry-run toggle, kill-switch) adds routes | **route-registrar**: modules export `routes`, server composes |
| `src/cli/index.ts` | modules add subcommands | **command-registrar**: modules export `commands`, CLI composes |

With Step S done, these parallelize cleanly and concurrently (own dirs):
- Floors: `egress` ∥ `caching`.
- P1: `gate-wall` ∥ `mcp` ∥ `dependency-install` ∥ `governed-exec` ∥ `spawning` ∥ `memory` ∥ `peh` ∥ `monitoring` (8-wide).
- P2: `cognition` ∥ `drift` ∥ `dry-run` ∥ `kill-switch`.

**Cannot freely parallelize (serialize or seam-first):**
- `dry-run` and `kill-switch` are cross-cutting: they only avoid touching every
  module's files IF their seam (a flag in `OperationContext` / a kill event modules
  subscribe to) is defined in Step S. Otherwise they'd edit many modules → serialize.
- `cognition` + `drift` both depend on `memory` → memory must land first (they then
  parallelize).
- `gate-wall` must define its `PromoteGovernance`-producing surface before
  `dependency-install` / `governed-exec` / workspace-promote callers rely on it —
  build gate-wall early in P1 (others can stub against its contract).

---

## 4. Per-module contract dependencies (pin via `assertContractCompatible`)

| Module | Frozen contracts it builds against |
|---|---|
| network-egress | substrate (config/state), events, receipts (record blocked attempts), identity (attribution) |
| caching/cost | provider (wraps `invokeModel`), substrate (DocumentStore cache), events |
| worker-model | provider, injection, identity, trust, workspace, events, receipts, caching |
| gate-wall | trust (`autonomyForTier`), workspace (`PromoteGovernance` seam), receipts, events, identity |
| subagent-spawning | worker-model, workspace, identity (`spawnedFrom`), events |
| mcp→model-loop | provider (tool-loop), injection (MCP results untrusted), egress, events, identity |
| dependency-install | egress, gate-wall, workspace (install in sandbox), receipts, identity |
| governed-sudo/curl | egress, gate-wall, receipts, identity, events |
| lab-context-memory | receipts (read-seam, project-scoped), substrate (durable projections), events |
| cognition-layer | provider, lab-context-memory, worker-model |
| drift-prevention | lab-context-memory, worker-model, receipts, events |
| self-observation/monitoring | events (subscribe), receipts (read), substrate |
| peh-agent | provider, identity, injection (user/untrusted input), events |
| dry-run/plan-only | identity (`OperationContext`), events; + the S dry-run seam |
| graceful-degradation/kill-switch | events, substrate, trust (`revalidate`), workspace (`reclaim`); + the S kill seam |

---

## 5. Stakes tiering (where Codex is needed)

**THREE-EYES (security-relevant — Codex + Hermes, desktop):**
- `network-egress` (SSRF / default-deny allowlist — exfiltration + internal-network reach)
- `mcp→model-loop` (untrusted tool results into a model + outbound to MCP servers)
- `governed-sudo/curl` (privileged command execution)
- `dependency-install` (arbitrary package fetch+exec — supply-chain)
- `gate-wall` (the enforcement layer; a bypass = ungoverned action)
- `subagent-spawning` (spawn-identity / trust-inheritance = escalation surface)
- `worker-model` (orchestrates untrusted content + drives the above)
- `graceful-degradation/kill-switch` (must actually halt; a failed kill is a safety gap)

**TWO-EYES (lower-stakes — Hermes-only, mobile-friendly):**
- `caching/cost` (cache correctness/cost; mild key-collision concern)
- `lab-context-memory` (durability/projection correctness, not security boundary)
- `cognition-layer`, `drift-prevention` (quality/behavior, not a boundary)
- `self-observation/monitoring` (read-only observation)
- `peh-agent` router/intent/Q&A (teacher content deferred)
- `dry-run/plan-only` (a safety *aid*; correctness matters but it gates, doesn't execute)

---

## 6. Open design decisions (need an operator call before building)

1. **`config.ts` strategy.** Per-module config readers (each module parses its own
   `IKBI_*`, `core/config.ts` frozen to core) vs keep central config (serializes
   module config edits). *Recommend per-module* — it's the cleanest parallel unlock.
2. **Route + CLI registration seam.** Confirm CC builds a route-registrar +
   command-registrar in Step S so modules own their endpoints/commands in their own
   files (no shared `server/`/`cli/` edits).
3. **Dry-run/plan-only model.** (a) a `dryRun` flag on `OperationContext` (additive
   to the identity contract — every side-effecting module checks it; a pre-req
   seam), vs (b) a per-module dry-run gate, vs (c) a wrapping interceptor at the
   action boundary. Determines whether dry-run is a seam-first or a late leaf.
4. **Kill-switch / graceful-degradation model.** (a) a kill-switch EVENT modules
   subscribe to + `trust.revalidate`/`workspace.reclaim` in-flight checks (seam in
   Step S), vs (b) a central coordinator that owns shutdown. Affects build timing.
5. **Caching as a chokepoint vs opt-in.** Must ALL model calls route through the
   cache (a single `invokeModel` wrapper all callers use) or is caching opt-in per
   call? Hard chokepoint = workers depend on caching; opt-in = looser.
6. **Egress as the provider's outbound fetch.** Should the frozen provider's HTTP
   (mimo/OpenRouter) be subjected to the SSRF floor by injecting egress as its
   `fetchImpl` at wiring time? (Integration wiring, not a contract change — but
   confirm the provider's outbound is governed.)
7. **Worker-model granularity.** Five roles as ONE module (one orchestrator + role
   files) vs five separate modules. Affects how wide the worker phase parallelizes.
8. **MCP untrusted-content enforcement.** Confirm MCP tool results are MANDATORY
   through `neutralizeUntrusted` (source `mcp_result`) before entering the model
   loop — enforced by the module, not optional.
9. **Memory projection schema.** What learned projections `lab-context-memory`
   persists (since receipts age out): success/failure patterns per agent+project,
   capability registry of "what exists," drift baselines? Its durable schema is a
   real design fork.
10. **Subagent spawn identity.** Spawned subagents: dynamically registered identities
    vs ephemeral identities carried via `spawnedFrom` under the parent's trust
    ceiling (the parent can't spawn above its own tier). Affects identity-registry
    interaction + the anti-escalation story.
11. **mimo direct-API base URL.** Still a placeholder (`IKBI_MIMO_BASE_URL`); the MCP
    / provider-touching work benefits from the real endpoint being confirmed.

---

## 7. Suggested first execution slice

`Step S` (CC solo) → then `egress` (3-eyes) ∥ `caching` (2-eyes) → then `worker-model`
(3-eyes) → then open the P1 fan-out. Resolve decisions #1–#6 before Step S, #7 before
the worker phase, #8–#10 before the relevant P1 modules.
