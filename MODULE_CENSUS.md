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
| mcp-model-loop | `ikbi mcp --server "<command>" <goal>` | Runs the governed MCP model+tool loop against an operator-configured **stdio** MCP server (every tool call gate-walled, every result neutralized). The default process-wide loop singleton still uses the in-process mock; `ikbi mcp` is the real, opt-in stdio entrypoint. |

## Reachable transitively / as a library

| Module | Invoked by | Kind |
| --- | --- | --- |
| deterministic-judge | worker-model (competitive mode scores candidates) | Transitive |
| drift-prevention | cognition-layer (`drift.check()` informs deliberation) | Transitive |
| gate-wall | worker-model (promote governance) + governed-exec (exec governance) | Transitive |
| governed-exec | worker-model (verifier routes its checks through it) | Transitive |
| lab-context-memory | agent-router, cognition-layer, capability-recovery (read cross-agent memory) | Transitive (read) |
| dependency-install | a future repair caller (capability-recovery RECOMMENDS it as data; never invokes) | Library (dormant) |
| subagent-spawning | the spawn surface consumers use to derive child identities | Library (dormant) |
| self-observation | the redacted event-ring consumers read for introspection | Library (dormant) |

The **Library (dormant)** modules are intentional typed surfaces with no live operator
path yet — each is annotated `@status dormant` / `@status library-only` in its `index.ts`
so the dormancy is explicit, not assumed. mcp-model-loop is **no longer** in this group:
its stdio path is now reachable via `ikbi mcp` (above), though its default singleton
remains a library/mock surface.

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

## Server (M8) — health + chat

The HTTP server (`src/server/`) exposes `/health` and `/ready` plus the engine's first
real module route: **`POST /chat`**, registered by the chat module
(`src/modules/chat/routes.ts`) through the route registry seam
(`src/server/registry.ts`). The registry is no longer empty — the seam is exercised: a
module registers its routes from its own file at import time, and chat does so. The CLI
remains the primary entrypoint for the build/governance commands; other HTTP engine routes
(status, Peh Q&A, dry-run toggle, kill-switch control) are still future work.

## Barrel

`src/modules/index.ts` side-effect-imports all **19** module directories under
`src/modules/` so each module's import-time initialization (contract pins, config slices,
event definitions, singletons, **command registration**) fires when ikbi starts. The CLI
(`src/cli/index.ts`) and the service entry import the barrel before they start, so every
CLI command above — `build`, `batch`, `classify`, `ask`, `recover`, `mcp`, `trust`,
`kill`/`unkill`/`kill-status` — is registered at startup, and chat's `POST /chat` route is
mounted. (cognition-layer is wired directly in the CLI as the bare-goal default router.)
