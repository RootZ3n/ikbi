/**
 * ikbi worker-model — BUILDER role (stub, pass-1).
 *
 * Scoped (pending 3-eyes): runs the model + tool loop, produces changes in the
 * workspace.
 *
 * #8 — MANDATORY NEUTRALIZATION: any MCP tool result MUST be routed through
 * `ctx.engine.neutralizeUntrusted(result, { source: "mcp_result", identity })`
 * BEFORE it enters the model loop. The seam lives on `RoleEngine`, so the builder
 * physically has it and the implementation cannot bypass it. The reference below
 * keeps that seam live (and forces the signature) while the body is stubbed.
 */

import type { RoleFn } from "./contract.js";

export const builder: RoleFn = async (ctx) => {
  // The mandatory #8 path the full implementation must use (kept live here so the
  // seam cannot be designed out before the body lands next pass):
  //   const safe = ctx.engine.neutralizeUntrusted(mcpResult, {
  //     source: "mcp_result", identity: ctx.identity,
  //   });
  //   // ...feed safe.wrapped into ctx.engine.invokeModel(...)
  void ctx.engine.neutralizeUntrusted;
  void ctx.engine.invokeModel;
  return {
    role: "builder",
    outcome: "stub",
    summary: `builder role not implemented (pass 1) for task ${ctx.task.taskId}`,
  };
};
