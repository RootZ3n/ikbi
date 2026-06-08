/**
 * HB-4 acceptance: IKBI_CHECKS configures the verifier's check command set. With npm-style
 * checks, the REAL verifier (via the live resolveChecks reading process.env) runs `npm`, not pnpm.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import { autonomyForTier } from "../core/trust/index.js";
import type { ExecRequest, ExecResult } from "../modules/governed-exec/index.js";
import type { WorkspaceHandle } from "../core/workspace/contract.js";
import { resolveChecks } from "../modules/worker-model/checks.js";
import { createVerifier } from "../modules/worker-model/verifier.js";
import type { RoleContext } from "../modules/worker-model/contract.js";
import { makeIdentities } from "./harness.js";

const ID: AgentIdentity = { agentId: "worker", functionalRole: "verifier", trustTier: "trusted", spawnedFrom: "lead" };

function recordingExec() {
  const calls: ExecRequest[] = [];
  return { calls, governedExec: { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }; } } };
}

function ctxFor(path: string): RoleContext {
  const ws: WorkspaceHandle = { id: "ws1", targetRepo: path, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path, identity: ID, state: "allocated", createdAt: 0 };
  return { task: { taskId: "t", targetRepo: path, goal: "g" }, role: "verifier", identity: ID, autonomy: autonomyForTier("trusted"), workspace: ws, priorResults: [], engine: { invokeModel: async () => { throw new Error("no model"); }, neutralizeUntrusted: () => { throw new Error("no"); } } };
}

test("HB-4: IKBI_CHECKS=npm ⇒ the verifier runs npm (not pnpm), using the live resolveChecks", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ikbi-accept-npm-")));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "npm-target", scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
  const saved = process.env.IKBI_CHECKS;
  process.env.IKBI_CHECKS = JSON.stringify([
    { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
    { name: "test", command: "npm", args: ["test"] },
  ]);
  try {
    const exec = recordingExec();
    const { parentCtx } = makeIdentities();
    // The REAL verifier with the LIVE resolveChecks (reads process.env.IKBI_CHECKS) + a clean diff.
    const result = await createVerifier({
      governedExec: exec.governedExec,
      parentCtx,
      diff: async () => "diff --git a/src/a.ts b/src/a.ts\n+x\n",
      resolveChecks: (ws) => resolveChecks(ws), // live — exactly how the orchestrator wires it
    })(ctxFor(dir));

    assert.equal(result.outcome, "success");
    assert.ok(exec.calls.length >= 1, "checks ran");
    for (const c of exec.calls) assert.equal(c.command, "npm", "every check ran via npm — the configured set, not the pnpm default");
    assert.ok(exec.calls.some((c) => c.args.join(" ") === "test"), "npm test was one of the checks");
    // Sanity: with IKBI_CHECKS unset, the same target resolves to the pnpm default.
    delete process.env.IKBI_CHECKS;
    const def = resolveChecks(dir);
    assert.equal(def.ok && def.checks[0]?.command, "pnpm", "default is still pnpm for ikbi itself");
  } finally {
    if (saved === undefined) delete process.env.IKBI_CHECKS; else process.env.IKBI_CHECKS = saved;
  }
});
