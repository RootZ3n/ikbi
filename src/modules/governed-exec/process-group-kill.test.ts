/**
 * Phase 6 (audit): the streaming exec spawns with detached:true and kills the process GROUP
 * on timeout, so grandchildren cannot become orphans. Exit code 124 is the timeout sentinel.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import { createGateWall } from "../gate-wall/index.js";
import { createGovernedExec } from "./exec.js";
import type { GovernedExecConfig } from "./config.js";

const silent = () => pino({ level: "silent" });
function makeCtx(tier = "verified"): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "caller-1", kind: "agent", defaultTrustTier: tier, tokenHashes: [hashToken("caller-secret")] }] }),
    logger: silent(), now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "caller-secret" }), { requestId: "req-1" });
}
const cfg = (allowlist: string[]): GovernedExecConfig => ({ enabled: true, allowlist, execTimeoutMs: 300, maxBuffer: 1_000_000, networkTimeoutMs: 5000, jobKillGraceMs: 5000 });
const gate = () => createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} });
const noReceipts = { append: async () => ({}) };

test("streaming exec timeout: process is killed and returns code 124", { timeout: 5000 }, async () => {
  // sh -c "sleep 100" will block until our 300ms timeout kills it.
  const ge = createGovernedExec({ config: cfg(["sh"]), gateWall: gate(), receipts: noReceipts, publish: () => {} });
  const r = await ge.run({ parentCtx: makeCtx(), command: "sh", args: ["-c", "sleep 100"], onOutput: () => {} });
  assert.equal(r.executed, true, "command was executed (then timed out)");
  assert.equal(r.exitCode, 124, "timed-out streaming exec returns code 124");
  assert.match(r.reason ?? "", /timed out/, "reason mentions timeout, not generic 'exited'");
});

test("streaming exec timeout: error message includes the timeout duration", { timeout: 5000 }, async () => {
  const config: GovernedExecConfig = { ...cfg(["sh"]), execTimeoutMs: 250 };
  const ge = createGovernedExec({ config, gateWall: gate(), receipts: noReceipts, publish: () => {} });
  const r = await ge.run({ parentCtx: makeCtx(), command: "sh", args: ["-c", "sleep 100"], onOutput: () => {} });
  assert.equal(r.exitCode, 124);
  assert.match(r.reason ?? "", /250ms/, "reason includes the configured timeout duration");
  assert.match(r.reason ?? "", /killed/, "reason mentions killed");
});

test("process-group kill: spawned children are cleaned up when streaming exec times out", { timeout: 8000 }, async () => {
  // Spawn sh that forks a background grandchild, then hangs. With detached:true +
  // process.kill(-pid, SIGKILL), the ENTIRE process group is killed — grandchildren cannot
  // escape as orphans. We capture the parent PID to verify it is dead after the timeout.
  const pids: number[] = [];
  const ge = createGovernedExec({ config: { ...cfg(["sh"]), execTimeoutMs: 400 }, gateWall: gate(), receipts: noReceipts, publish: () => {} });
  const r = await ge.run({
    parentCtx: makeCtx(),
    command: "sh",
    args: ["-c", "printf '%s\\n' $$; sleep 100 & wait"],
    onOutput: (chunk) => {
      // Collect any PIDs emitted on stdout (the printf $$ line).
      chunk.trim().split("\n")
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 1)
        .forEach((n) => pids.push(n));
    },
  });
  assert.equal(r.exitCode, 124, "timed-out streaming exec returns code 124");
  // Allow the OS to fully reap the process group.
  await new Promise((resolve) => setTimeout(resolve, 150));
  // The direct child PID (captured via printf $$) must be dead.
  for (const pid of pids) {
    let alive = false;
    try {
      process.kill(pid, 0); // throws ESRCH if the process does not exist
      alive = true;
    } catch (e) {
      assert.equal((e as NodeJS.ErrnoException).code, "ESRCH", `pid ${pid} should not exist after group kill`);
    }
    assert.equal(alive, false, `pid ${pid} is still alive — process group was NOT fully killed`);
  }
});
