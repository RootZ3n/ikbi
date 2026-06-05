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
 * Modules register routes/commands in the later barrel-wiring step; none do so yet,
 * so importing here only initializes them. Nothing below performs active work at
 * import (no server bind, no network, no exec, no disk write) — registration and
 * in-memory singleton construction only.
 */

// EGRESS FIRST — registers the fetch guard before any model-invocation path.
import "./egress/index.js";

// The remaining built modules (order otherwise non-significant — each is independent).
import "./cache/index.js";
import "./worker-model/index.js";
import "./gate-wall/index.js";
import "./subagent-spawning/index.js";
import "./governed-exec/index.js";
import "./mcp-model-loop/index.js";
import "./dependency-install/index.js";
import "./lab-context-memory/index.js";
import "./agent-router/index.js";
import "./self-observation/index.js";
// Orchestration layer above worker-model (registers the `batch` command on import).
import "./batch-planner/index.js";
