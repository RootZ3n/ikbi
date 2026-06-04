/**
 * ikbi worker-model — VERIFIER role (stub, pass-1).
 *
 * Scoped (pending 3-eyes): runs objective checks (tests/typecheck) against the
 * workspace, produces a verdict. Body lands in a follow-up pass.
 */

import type { RoleFn } from "./contract.js";

export const verifier: RoleFn = async (ctx) => ({
  role: "verifier",
  outcome: "stub",
  summary: `verifier role not implemented (pass 1) for task ${ctx.task.taskId}`,
});
