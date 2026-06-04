/**
 * ikbi worker-model — CRITIC role (stub, pass-1).
 *
 * Scoped (pending 3-eyes): reviews builder output against task intent, produces
 * pass/fail + feedback. Body lands in a follow-up pass.
 */

import type { RoleFn } from "./contract.js";

export const critic: RoleFn = async (ctx) => ({
  role: "critic",
  outcome: "stub",
  summary: `critic role not implemented (pass 1) for task ${ctx.task.taskId}`,
});
