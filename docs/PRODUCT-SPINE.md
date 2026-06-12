# Ikbi Product Spine

This document defines the product Ikbi is trying to be, independent of historical
module accretion.

## Product Promise

Ikbi is a local coding agent for Jeff's lab work. The primary promise is:

1. Jeff points Ikbi at a repo.
2. Ikbi understands the repo enough to choose the right files.
3. Ikbi edits through a controlled lifecycle.
4. Ikbi verifies with receipts the operator can inspect.
5. Ikbi either lands the change explicitly or preserves recoverable work.
6. Ikbi makes its safety posture visible before, during, and after the run.

Anything that does not improve that path is supporting utility, an adapter, or
dormant/future surface.

## Golden Path

The golden path is the daily coding loop:

```text
operator intent
  -> target repo resolution
  -> project instructions and memory
  -> retrieval/index context
  -> model/tool loop
  -> file edits in an auditable workspace
  -> deterministic checks
  -> diff review
  -> explicit promote/apply or retained/discarded work
  -> receipts/status/doctor expose what happened
```

The production build implementation is currently the strongest version of this
spine:

```text
src/cli/index.ts
  -> src/modules/worker-model/cli.ts
  -> createProductionWorker()
  -> src/modules/worker-model/orchestrator.ts
  -> src/core/workspace/manager.ts
  -> scout/builder/critic/verifier/integrator
  -> gate-wall/governed-exec/dependency-install/project-retrieval
  -> workspace promote/retain/discard
```

The interactive product should converge on the same lifecycle instead of carrying
a separate editing and rollback model.

## Product Surfaces

Ikbi has three operator-facing surfaces:

- CLI build path: `ikbi build`, `ikbi diff`, `ikbi workspace`, `ikbi undo`.
- Interactive path: `ikbi repl`.
- HTTP service path: `/health`, `/ready`, `/agent`, `/capabilities`, `/chat`.

The CLI build path is the reference spine. REPL and HTTP chat are adapters unless
they use the same lifecycle, safety, and status semantics.

## Classification Vocabulary

- Core golden path: required for the daily coding loop or promotion lifecycle.
- Supporting utility: required by core paths but not itself a product surface.
- Interface adapter: CLI, HTTP, TUI, shell, or route glue over core behavior.
- Dormant/future: imported or tested but not exercised by default production use.
- Legacy/deprecated: older behavior kept for compatibility or tests, not desired.
- Dangerous parallel path: an alternate way to edit, execute, verify, or route that
  bypasses the golden path or gives weaker guarantees under similar product wording.

## Current Product Spine Map

| Path | Classification | Product role |
| --- | --- | --- |
| `src/index.ts` | Interface adapter | Starts the HTTP service and loads the module barrel. |
| `src/server/` | Interface adapter | Fastify health, capability, agent, and chat endpoints. |
| `src/cli/index.ts` | Interface adapter | Main command dispatcher and bare-goal router host. |
| `src/cli/doctor.ts` | Core golden path | Operator readiness and safety posture report. |
| `src/cli/capabilities.ts` | Supporting utility | Tool-surface visibility. |
| `src/cli/workspace.ts` | Core golden path | Inspect/discard retained build workspaces. |
| `src/cli/undo.ts` | Core golden path | Post-promotion recovery by receipt/ref. |
| `src/cli/clean.ts` | Supporting utility | Workspace hygiene, with retained-work protection. |
| `src/cli/receipts.ts` | Supporting utility | Operational receipt inspection. |
| `src/cli/serve.ts` | Interface adapter | CLI wrapper for HTTP service startup. |
| `src/cli/bootstrap.ts` | Supporting utility | `.env` preload for CLI startup. |
| `src/core/config.ts` | Core golden path | Single typed configuration seam. |
| `src/core/provider/` | Core golden path | Model registry, invocation, provider guard, circuit breaker. |
| `src/core/identity/` | Core golden path | Operator/worker identity and operation context. |
| `src/core/trust/` | Core golden path | Trust tiers and autonomy. |
| `src/core/workspace/` | Core golden path | Durable worktree lifecycle, promote, retain, discard, diff. |
| `src/core/injection/` | Core golden path | Prompt/tool-output neutralization. |
| `src/core/receipt/` | Core golden path | Durable operational receipts. |
| `src/core/substrate/` | Supporting utility | Atomic writes and locking. |
| `src/core/events/` | Supporting utility | In-process progress and lifecycle events. |
| `src/core/contracts/` | Supporting utility | Contract-version assertions. |
| `src/core/goal-refinement.ts` | Supporting utility | Pre-build prompt refinement. |
| `src/core/repo-registry.ts` | Supporting utility | Repo alias/path resolution. |
| `src/core/kill-switch.ts` | Supporting utility | Core kill-switch primitive. |
| `src/modules/index.ts` | Interface adapter | Activation barrel for commands/routes/side effects. |
| `src/modules/worker-model/` | Core golden path | Main build pipeline, roles, verification, competitive mode. |
| `src/modules/worker-model/builder-tools/` | Core golden path | Tools exposed to the build loop and largely mirrored by chat. |
| `src/modules/chat/` | Interface adapter (REPL repo mode) / Dangerous parallel path (HTTP + scratch) | Phases 2–3: REPL repo-mode sessions share the build path's managed-workspace lifecycle (isolated worktree → `/diff` → explicit `/apply` → `/discard`), and `/apply` runs the SAME ladder verification as `ikbi build`, promoting only on a pass (fail-closed otherwise). Remaining delta vs build: the operator-driven single loop has no scout/critic/integrator. `--scratch` and HTTP `/chat` remain non-managed/ephemeral (a disclosed weaker path). |
| `src/modules/project-index/` | Core golden path | Deterministic project index used by retrieval. |
| `src/modules/project-retrieval/` | Core golden path | Goal-relevant context selection over the index. |
| `src/modules/verification-ladder/` | Core golden path | Hardened verification semantics. |
| `src/modules/check-triage/` | Core golden path | Check-output classification supporting verification trust. |
| `src/modules/gate-wall/` | Core golden path | Promote/exec governance. |
| `src/modules/governed-exec/` | Core golden path | Controlled command execution for checks/tools. |
| `src/modules/dependency-install/` | Supporting utility | Hardened dependency install used by orchestrator when needed. |
| `src/modules/deterministic-judge/` | Supporting utility | Competitive candidate scoring. |
| `src/modules/egress/` | Core golden path | Network egress guard and fetch boundary. |
| `src/modules/cache/` | Supporting utility | Provider response cache singleton. |
| `src/modules/escalation/` | Supporting utility | Observe-only escalation scoring/events. |
| `src/modules/cognition-layer/` | Dangerous parallel path | Bare-goal deliberation/auto-dispatch can route before operator clarity. |
| `src/modules/batch-planner/` | Dangerous parallel path | Multi-run orchestration that can diverge from single-build behavior. |
| `src/modules/agent-router/` | Dormant/future | Lab Q&A/classification, not daily repo-editing spine. |
| `src/modules/capability-client/` | Dormant/future | Optional capability-ledger integration. |
| `src/modules/capability-recovery/` | Dormant/future | Diagnostic plan surface, non-executing. |
| `src/modules/drift-prevention/` | Supporting utility | Read-only signal for cognition. |
| `src/modules/lab-context-memory/` | Supporting utility | Cross-agent memory reader/writer with redaction. |
| `src/modules/mcp-model-loop/` | Dangerous parallel path | Separate model/tool loop with stdio MCP tools. |
| `src/modules/self-observation/` | Dormant/future | Redacted event-ring introspection. |
| `src/modules/subagent-spawning/` | Dangerous parallel path | Secondary orchestrator consumer with its own spawn surface. |
| `src/modules/trust/` | Interface adapter | CLI adapter for core trust operations. |
| `src/modules/kill-switch/` | Interface adapter | CLI adapter for kill-switch state. |
| `src/acceptance/` | Supporting utility | Product-shaped tests. |
| `tui/` | Interface adapter | External client for HTTP chat. |
| `deploy/` | Interface adapter | Systemd packaging. |
| `docs/` | Supporting utility | Operator/design memory; not a runtime guarantee. |

## Spine Rules

1. A product feature is live only if reached from CLI, server, or TUI defaults.
2. A feature is not proven by import reachability alone.
3. Build, REPL, HTTP chat, batch, MCP, and sub-agent paths must either share the
   same lifecycle or clearly disclose weaker semantics.
4. Any path that can mutate files or run commands must be visible in doctor/status
   and have an operator recovery story.
5. Tests should prove product behavior from an entrypoint whenever the guarantee is
   user-facing.

