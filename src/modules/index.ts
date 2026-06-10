/**
 * ikbi modules — THE ACTIVATION BARREL.
 *
 * The service entry (`src/index.ts`) and the CLI (`src/cli/index.ts`) side-effect-
 * import THIS file before they start. Importing it loads every built module, which
 * fires each module's import-time initialization: contract-version pins
 * (`assertContractCompatible`), config slices, event-type definitions, and the
 * process-wide singletons (`gateWall`, `orchestrator`, `labMemory`, …). This is the
 * single seam that turns the engine's modules ON when ikbi starts.
 *
 * ORDERING — EGRESS FIRST (load-bearing): `egress/index.ts` calls `register()` at
 * module scope, installing the SSRF fetch guard via `registerFetchGuard`. Any model
 * invocation resolves that guard (`resolveFetchGuard` THROWS `EgressGuardMissingError`
 * if it is absent), so egress MUST initialize before anything on a model-invocation
 * path. It is therefore imported first. (Modules resolve the guard only at CALL time,
 * never at import, so egress-first is sufficient.)
 *
 * These are SIDE-EFFECT imports (no bindings pulled in) — loading is the point.
 * Importing a module fires its registrations: worker-model (`build`), batch-planner
 * (`batch`), agent-router (`classify`/`ask`), capability-recovery (`recover`),
 * mcp-model-loop (`mcp`), trust (`trust`), and kill-switch (`kill`/`unkill`/
 * `kill-status`) register CLI commands; chat registers the `POST /chat` HTTP route.
 * (cognition-layer is the CLI's bare-goal default router, wired directly in
 * `src/cli/index.ts` rather than as a named command.) Nothing below performs active
 * work at import (no server bind, no network, no exec, no disk write) — command/route
 * registration and in-memory singleton construction only.
 */

// EGRESS FIRST — registers the fetch guard before any model-invocation path.
import "./egress/index.js";

// The remaining built modules (order otherwise non-significant — each is independent).
import "./cache/index.js";
import "./worker-model/index.js";
// Escalation — deterministic model-tier escalation engine; the worker-model
// orchestrator hooks it (additively) to score attempts and emit escalation.* events.
import "./escalation/index.js";
import "./gate-wall/index.js";
import "./subagent-spawning/index.js";
import "./governed-exec/index.js";
import "./mcp-model-loop/index.js";
import "./dependency-install/index.js";
import "./lab-context-memory/index.js";
// Capability-client — read-only HTTP client for the lab Capability Ledger; the
// agent-router consults it for capability-driven model selection (graceful fallback
// to static config when the ledger is down). Loaded before agent-router (its consumer).
import "./capability-client/index.js";
import "./agent-router/index.js";
import "./self-observation/index.js";
// Chat — registers the POST /chat conversational endpoint (persistent sessions + tool loop).
import "./chat/index.js";
// Orchestration layer above worker-model (registers the `batch` command on import).
import "./batch-planner/index.js";
// Capability-recovery diagnostic (registers the `recover` operator command on import).
import "./capability-recovery/index.js";
// Trust operator CLI (registers the `trust` grant/status command — the cold-start on-ramp).
import "./trust/index.js";
// Kill-switch LAST — its index reads the durable latch at engine start (graceful
// degradation), and registers the `kill`/`unkill`/`kill-status` operator commands.
import "./kill-switch/index.js";
