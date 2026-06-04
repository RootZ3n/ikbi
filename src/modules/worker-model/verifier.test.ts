import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { createVerifier, type CheckResult, type CheckRunner } from "./verifier.js";
import type { RoleContext } from "./contract.js";

const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "verifier", trustTier: "verified", spawnedFrom: "parent-1" };
const WS_PATH = "/workspace/ws1";

function makeCtx() {
  let invokeCalls = 0;
  const ws: WorkspaceHandle = {
    id: "ws1", targetRepo: WS_PATH, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: WS_PATH, identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  const ctx: RoleContext = {
    task: { taskId: "t-1", targetRepo: WS_PATH, goal: "verify" },
    role: "verifier",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace: ws,
    priorResults: [],
    engine: {
      invokeModel: async () => {
        invokeCalls += 1;
        throw new Error("verifier must never call invokeModel");
      },
      neutralizeUntrusted: () => {
        throw new Error("verifier must not neutralize");
      },
    },
  };
  return { ctx, invokeCalls: () => invokeCalls };
}

test("all checks pass → outcome:success, and the runner ran in ctx.workspace.path", async () => {
  const seenCwds: string[] = [];
  const runner: CheckRunner = (_cmd, _args, cwd) => {
    seenCwds.push(cwd);
    return { exitCode: 0, output: "ok" };
  };
  const { ctx, invokeCalls } = makeCtx();
  const result = await createVerifier(runner)(ctx);

  assert.equal(result.outcome, "success");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "pass");
  assert.equal(detail.checks.length, 2, "ran the fixed check set");
  assert.ok(seenCwds.length >= 1 && seenCwds.every((c) => c === WS_PATH), "every check ran in the workspace path");
  assert.equal(invokeCalls(), 0, "verifier is deterministic — never calls invokeModel");
});

test("a failing check → outcome:failure with the failed command in detail", async () => {
  const runner: CheckRunner = (cmd, args) => {
    const command = `${cmd} ${args.join(" ")}`;
    return command.includes("test") ? { exitCode: 1, output: "1 failing" } : { exitCode: 0, output: "ok" };
  };
  const { ctx } = makeCtx();
  const result = await createVerifier(runner)(ctx);

  assert.equal(result.outcome, "failure");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "fail");
  const failed = detail.checks.find((c) => c.exitCode !== 0);
  assert.ok(failed, "a failed check is recorded");
  assert.match(failed.command, /test/);
  assert.match(result.summary ?? "", /test/);
});

test("verifier never invokes the model (asserted via the engine spy)", async () => {
  const runner: CheckRunner = () => ({ exitCode: 0, output: "" });
  const { ctx, invokeCalls } = makeCtx();
  await createVerifier(runner)(ctx);
  assert.equal(invokeCalls(), 0);
});
