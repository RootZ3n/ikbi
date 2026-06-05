# ikbi Module Census — Reachability Map

How every built module is actually invoked today. "Built" and "reachable" are not the
same thing; this map records the invocation path of each module so an orphan (built +
tested but with no importer, caller, or entrypoint) is visible rather than assumed-wired.

Resolves the M8 (server is health-only) and M9 (barrel/orphan) honesty findings.

## Categories

- **CLI** — an operator types a command (`ikbi …`); the command is registered at barrel
  load and composed by `src/cli/index.ts`.
- **Transitive** — invoked by another module in-process as part of a larger flow (no
  direct entrypoint of its own; reached through its consumer).
- **Library** — a typed surface designed to be called by a consumer (present or future);
  having **no** CLI command is a documented design choice, not a gap.
- **Side-effect** — initializes at barrel import (installs a guard / constructs a
  singleton); never "called" directly.

## Reachable via CLI

| Module | Command(s) | Notes |
| --- | --- | --- |
| worker-model | `ikbi build <goal> [--repo]` | The 5-role governed build pipeline. |
| batch-planner | `ikbi batch <goal> [--repo]` | Decompose → run each subtask through the **same** governed worker as `build` (C2). |
| cognition-layer | `ikbi <goal>` (default router) | The bare-goal default: deliberates the path + recommends the next command. Wired in `src/cli/index.ts` as the fallback (not a named command). |
| agent-router | `ikbi classify`, `ikbi ask` | Intent classification + cross-agent Q&A over lab memory. |
| kill-switch | `ikbi kill`, `ikbi unkill`, `ikbi kill-status` | Operator emergency halt; reads the durable latch at startup. |
| capability-recovery | `ikbi recover <capability> [--project]` | **NEW (M9).** Operator DIAGNOSTIC: prints a `CapabilityRecoveryPlan` (what broke, the likely cause class, which module should repair it). **Non-executing** — it recommends, never dispatches the repair. |

## Reachable transitively / as a library

| Module | Invoked by | Kind |
| --- | --- | --- |
| deterministic-judge | worker-model (competitive mode scores candidates) | Transitive |
| drift-prevention | cognition-layer (`drift.check()` informs deliberation) | Transitive |
| gate-wall | worker-model (promote governance) + governed-exec (exec governance) | Transitive |
| governed-exec | worker-model (verifier routes its checks through it) | Transitive |
| lab-context-memory | agent-router, cognition-layer, capability-recovery (read cross-agent memory) | Transitive (read) |
| dependency-install | a future repair caller (capability-recovery RECOMMENDS it as data; never invokes) | Library |
| mcp-model-loop | a standalone governed MCP tool loop for its consumers | Library |
| subagent-spawning | the spawn surface consumers use to derive child identities | Library |
| self-observation | the redacted event-ring consumers read for introspection | Library |

The **Library** modules are intentional: each is a typed surface called by its consumer
or designed for a future caller. No CLI command is a design choice, not an orphan.

### capability-recovery — dual role (recorded so it is not re-flagged as orphaned)

1. **Operator diagnostic today** — `ikbi recover <capability>` prints the plan.
2. **Library surface for the future agent-runtime / Peh coordinator** — when that runtime
   detects a broken capability it calls `assess()` and dispatches the returned
   `CapabilityRecoveryPlan` itself. capability-recovery produces the plan; it never
   executes the repair (it imports none of the repair modules — the boundary is enforced
   by a test).

## Side-effect (barrel import)

| Module | Effect at import |
| --- | --- |
| egress | Installs the SSRF fetch guard (`registerFetchGuard`). Imported **first** in the barrel — any model-invocation path resolves this guard at call time and throws if it is absent. |
| cache | Constructs the provider response cache singleton. |

## Server (M8) — Phase 0 health-only

The HTTP server (`src/server/`) is a **Phase 0 health-check skeleton**. It exposes
**only** `/health` and `/ready` — no engine routes. The route registry
(`src/server/registry.ts`) is a parallel-build **seam**: a module may register its routes
from its own file at import time, but **none do yet** — the registry is intentionally
empty. The **CLI is the real entrypoint today**; HTTP engine routes (status, Peh Q&A,
dry-run toggle, kill-switch control) are future work. The server is **not** an orphan — it
is a documented Phase 0 skeleton, deliberately without speculative routes.

## Barrel

`src/modules/index.ts` side-effect-imports every module so its import-time initialization
(contract pins, config slices, event definitions, singletons, **command registration**)
fires when ikbi starts. capability-recovery is now barrel-imported (it registers the
`recover` command). The CLI (`src/cli/index.ts`) and the service entry import the barrel
before they start, so every CLI command above is registered at startup.
