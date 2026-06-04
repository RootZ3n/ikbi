/**
 * ikbi worker-model — INTEGRATOR role (stub, pass-1).
 *
 * Scoped (pending 3-eyes): produces the promote DECISION on success / discard on
 * failure. NOTE: the workspace lifecycle (allocate/promote/discard) is EXECUTED by
 * the orchestrator (freeze-critical) — the integrator role supplies the decision
 * the orchestrator enacts, it does not call workspace.promote itself. Body lands
 * in a follow-up pass.
 */

import type { RoleFn } from "./contract.js";

export const integrator: RoleFn = async (ctx) => ({
  role: "integrator",
  outcome: "stub",
  summary: `integrator role not implemented (pass 1) for task ${ctx.task.taskId}`,
});
