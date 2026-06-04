/**
 * ikbi worker-model — SCOUT role (stub, pass-1).
 *
 * Scoped (pending 3-eyes): read-only investigation — gather repo/context, produce
 * findings. NO writes. Body lands in a follow-up pass; this is the typed seam the
 * orchestrator dispatches.
 */

import type { RoleFn } from "./contract.js";

export const scout: RoleFn = async (ctx) => ({
  role: "scout",
  outcome: "stub",
  summary: `scout role not implemented (pass 1) for task ${ctx.task.taskId}`,
});
