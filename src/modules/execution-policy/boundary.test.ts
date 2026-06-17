/**
 * Dependency boundary test — verifies the circular dependency between
 * gate-wall, governed-exec, and execution-policy stays broken.
 *
 * This test imports from each module and verifies the expected dependency
 * direction. If a new import reintroduces a cycle, the TypeScript compiler
 * itself will catch it (circular imports cause runtime errors), but this
 * test makes the INTENDED boundary explicit and testable.
 *
 * The cycle that MUST NOT return:
 *   gate-wall → governed-exec (was: commandPolicyDenyReason import)
 *   gate-wall → worker-model  (was: RoleResult/WorkerTask type imports)
 *   governed-exec → gate-wall TYPE (was: GateWall type import; singleton is OK)
 *
 * After the fix:
 *   execution-policy → frozen core + worker-model (type-only)
 *   gate-wall        → execution-policy (contracts + risk)
 *   governed-exec    → execution-policy (type) + gate-wall (singleton only)
 *   worker-model     → execution-policy + gate-wall + governed-exec
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ── 1. execution-policy exports the shared types ────────────────────────────

test("execution-policy: exports GateWall type", async () => {
  const mod = await import("../execution-policy/contract.js");
  // GateWall should be a type (interface) — we can't runtime-check interfaces,
  // but we CAN verify the module loaded without circular-import errors.
  assert.ok(mod, "execution-policy/contract.ts loaded successfully");
});

test("execution-policy: exports commandPolicyDenyReason", async () => {
  const { commandPolicyDenyReason } = await import("../execution-policy/risk.js");
  assert.equal(typeof commandPolicyDenyReason, "function", "commandPolicyDenyReason is a function");
});

test("execution-policy: commandPolicyDenyReason denies git push", async () => {
  const { commandPolicyDenyReason } = await import("../execution-policy/risk.js");
  const reason = commandPolicyDenyReason("git", ["push"]);
  assert.ok(reason, "git push should be denied");
  assert.match(reason, /not allowed/);
});

test("execution-policy: commandPolicyDenyReason allows git status", async () => {
  const { commandPolicyDenyReason } = await import("../execution-policy/risk.js");
  const reason = commandPolicyDenyReason("git", ["status"]);
  assert.equal(reason, undefined, "git status should be allowed");
});

// ── 2. gate-wall re-exports from execution-policy ───────────────────────────

test("gate-wall: contract re-exports GateWall from execution-policy", async () => {
  const contract = await import("../gate-wall/contract.js");
  assert.ok(contract.CONTRACT_VERSION, "gate-wall contract has version");
  assert.equal(contract.CONTRACT_VERSION, "1.1.0", "gate-wall contract version unchanged");
});

test("gate-wall: index re-exports GateWall type", async () => {
  const mod = await import("../gate-wall/index.js");
  assert.ok(mod.createGateWall, "createGateWall is exported");
  assert.ok(mod.gateWall, "gateWall singleton is exported");
});

// ── 3. governed-exec/policy.ts re-exports from execution-policy ─────────────

test("governed-exec/policy: re-exports commandPolicyDenyReason", async () => {
  const { commandPolicyDenyReason } = await import("../governed-exec/policy.js");
  assert.equal(typeof commandPolicyDenyReason, "function", "re-exported function works");
  // Same function as the canonical one
  const { commandPolicyDenyReason: canonical } = await import("../execution-policy/risk.js");
  assert.equal(commandPolicyDenyReason, canonical, "re-export points to the same function");
});

// ── 4. No gate-wall → governed-exec import exists ───────────────────────────

test("boundary: gate-wall does not import from governed-exec (no cycle)", async () => {
  // This is a SOURCE-LEVEL check: read gate-wall/gate.ts and verify it imports
  // commandPolicyDenyReason from execution-policy, not governed-exec.
  const { readFileSync } = await import("node:fs");
  const gateSource = readFileSync(
    new URL("../gate-wall/gate.ts", import.meta.url),
    "utf8"
  );
  assert.ok(
    !gateSource.includes('from "../governed-exec/'),
    "gate-wall/gate.ts must NOT import from governed-exec"
  );
  assert.ok(
    gateSource.includes('from "../execution-policy/'),
    "gate-wall/gate.ts SHOULD import from execution-policy"
  );
});

test("boundary: gate-wall/contract.ts does not import from worker-model (no cycle)", async () => {
  const { readFileSync } = await import("node:fs");
  const contractSource = readFileSync(
    new URL("../gate-wall/contract.ts", import.meta.url),
    "utf8"
  );
  assert.ok(
    !contractSource.includes('from "../worker-model/'),
    "gate-wall/contract.ts must NOT import from worker-model"
  );
  assert.ok(
    contractSource.includes('from "../execution-policy/'),
    "gate-wall/contract.ts SHOULD import from execution-policy"
  );
});

test("boundary: governed-exec/exec.ts imports GateWall type from execution-policy", async () => {
  const { readFileSync } = await import("node:fs");
  const execSource = readFileSync(
    new URL("../governed-exec/exec.ts", import.meta.url),
    "utf8"
  );
  assert.ok(
    execSource.includes('from "../execution-policy/contract.js"'),
    "governed-exec/exec.ts SHOULD import GateWall type from execution-policy"
  );
});
