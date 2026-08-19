/**
 * ikbi v2 — the public surface.
 *
 * v2 is a NEW canonical spine being built inside this repository one architectural
 * slice at a time. v1 (`src/core`, `src/modules`, `src/cli`) is the donor and remains
 * the shipping engine; v2 is experimental and reachable only through `ikbi v2`.
 *
 * ISOLATION RULE (enforced by src/v2/core/isolation.test.ts):
 *   - nothing under `src/v2/core/` imports v1
 *   - `src/v2/cli/` may import ONLY the v1 CLI command registrar and its io helpers
 *   - no v1 file imports v2, except the single registration line in `src/cli/index.ts`
 */

export * from "./core/identity.js";
export * from "./core/config.js";
export * from "./core/failure.js";
export * from "./core/lifecycle.js";
export * from "./core/result.js";
export * from "./core/contract.js";
export * from "./core/cost.js";
export * from "./core/run.js";
