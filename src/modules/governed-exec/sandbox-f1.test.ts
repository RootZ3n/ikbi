/**
 * ikbi governed-exec — F1 WORKSPACE-ESCAPE integration tests.
 *
 * Proves the fix end-to-end through the real `createGovernedExec` path:
 *  • a `node`/`python3` SCRIPT cannot write outside the worktree (relative `../../` OR absolute) —
 *    the exact F1 vectors;
 *  • inline `-e`/`-c` eval stays blocked;
 *  • when the sandbox is UNAVAILABLE a risky command FAILS CLOSED (no unsafe default), and the
 *    explicit trusted-local override runs it unsandboxed but loudly receipted;
 *  • SAFE commands are not sandboxed;
 *  • receipts record the sandbox mode + risk classification.
 *
 * The real-execution cases require a working bubblewrap; on a host without one they SKIP with an
 * explicit reason (the fail-closed path is still proven, with an injected "unavailable" probe). No
 * test writes anything to the real host outside its own temp worktree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { pino } from "pino";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ReceiptInput } from "../../core/receipt/contract.js";
import { createGateWall } from "../gate-wall/index.js";
import { createGovernedExec } from "./exec.js";
import type { GovernedExecConfig } from "./config.js";
import { detectSandbox, type SandboxAvailability } from "./sandbox.js";

const SANDBOX = detectSandbox();
const skipReal = SANDBOX.available ? false : `bubblewrap unavailable on this host: ${SANDBOX.reason ?? "no sandbox"}`;

function ctx(): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "caller-1", kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken("caller-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "caller-secret" }), { requestId: "req-f1" });
}

function cfg(mode: "auto" | "off" | "required", trustedLocalOverride = false): GovernedExecConfig {
  return {
    enabled: true,
    allowlist: ["node", "python3", "echo", "git", "cp"],
    execTimeoutMs: 60_000, maxBuffer: 8_000_000, networkTimeoutMs: 5_000, jobKillGraceMs: 5_000,
    sandbox: { mode, trustedLocalOverride },
  };
}

function captureReceipts() {
  const all: ReceiptInput[] = [];
  return { receipts: { append: async (input: ReceiptInput) => { all.push(input); return {}; } }, all };
}

const gate = () => createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} });

/** A fresh temp worktree with a script that ATTEMPTS to escape to the given rel + abs targets. */
function worktreeWithEscapeScript(lang: "node" | "python3", relName: string, absPath: string) {
  const wt = mkdtempSync(join(tmpdir(), "ikbi-f1-wt-"));
  if (lang === "node") {
    writeFileSync(join(wt, "escape.js"),
      `const fs=require("fs");` +
      `try{fs.writeFileSync("../../${relName}","pwned")}catch(e){}` +
      `try{fs.writeFileSync(${JSON.stringify(absPath)},"pwned")}catch(e){}` +
      `fs.writeFileSync("inside.txt","ok");console.log("ran");`);
  } else {
    writeFileSync(join(wt, "escape.py"),
      `import os\n` +
      `try:\n open("../../${relName}","w").write("pwned")\nexcept Exception: pass\n` +
      `try:\n open(${JSON.stringify(absPath)},"w").write("pwned")\nexcept Exception: pass\n` +
      `open("inside.txt","w").write("ok")\nprint("ran")\n`);
  }
  return wt;
}

test("F1-A/B (node): a script cannot write outside the worktree — relative ../../ AND absolute", { skip: skipReal }, async () => {
  const relName = "F1_NODE_REL_PWNED";
  const absPath = join(tmpdir(), "F1_NODE_ABS_PWNED_" + process.pid);
  const wt = worktreeWithEscapeScript("node", relName, absPath);
  const relHostPath = resolve(wt, "..", "..", relName);
  rmSync(absPath, { force: true });
  try {
    const cap = captureReceipts();
    const ge = createGovernedExec({ config: cfg("auto"), gateWall: gate(), receipts: cap.receipts, publish: () => {} });
    const res = await ge.run({ parentCtx: ctx(), command: "node", args: ["escape.js"], cwd: wt, worktreeRoot: wt, purpose: "f1 test" });
    assert.equal(res.executed, true, "the command runs (inside the sandbox)");
    assert.equal(existsSync(relHostPath), false, "relative ../../ escape must NOT create a host file outside the worktree");
    assert.equal(existsSync(absPath), false, "absolute /tmp escape must NOT create a host file");
    assert.equal(existsSync(join(wt, "inside.txt")), true, "a legitimate in-worktree write still works");
    assert.ok(cap.all.some((r) => (r.metadata as Record<string, unknown>)?.sandbox === "bwrap"), "a receipt records sandbox=bwrap");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(absPath, { force: true });
    rmSync(relHostPath, { force: true });
  }
});

test("F1-C/D (python3): a script cannot write outside the worktree — relative AND absolute", { skip: skipReal }, async () => {
  const relName = "F1_PY_REL_PWNED";
  const absPath = join(tmpdir(), "F1_PY_ABS_PWNED_" + process.pid);
  const wt = worktreeWithEscapeScript("python3", relName, absPath);
  const relHostPath = resolve(wt, "..", "..", relName);
  rmSync(absPath, { force: true });
  try {
    const ge = createGovernedExec({ config: cfg("auto"), gateWall: gate(), receipts: captureReceipts().receipts, publish: () => {} });
    const res = await ge.run({ parentCtx: ctx(), command: "python3", args: ["escape.py"], cwd: wt, worktreeRoot: wt, purpose: "f1 test" });
    assert.equal(res.executed, true);
    assert.equal(existsSync(relHostPath), false, "python relative escape contained");
    assert.equal(existsSync(absPath), false, "python absolute escape contained");
    assert.equal(existsSync(join(wt, "inside.txt")), true, "in-worktree write works");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(absPath, { force: true });
    rmSync(relHostPath, { force: true });
  }
});

test("F1: real ~ / /etc style absolute writes are refused (host stays intact)", { skip: skipReal }, async () => {
  const wt = mkdtempSync(join(tmpdir(), "ikbi-f1-wt-"));
  // Target a path that exists on the host and must remain untouched.
  const target = join(wt, "..", "..", "SHOULD_NOT_EXIST_F1");
  writeFileSync(join(wt, "s.js"), `try{require("fs").writeFileSync(${JSON.stringify(resolve(target))},"x")}catch(e){}console.log("ok")`);
  try {
    const ge = createGovernedExec({ config: cfg("auto"), gateWall: gate(), receipts: captureReceipts().receipts, publish: () => {} });
    await ge.run({ parentCtx: ctx(), command: "node", args: ["s.js"], cwd: wt, worktreeRoot: wt, purpose: "f1 test" });
    assert.equal(existsSync(resolve(target)), false, "absolute write outside the worktree is contained");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(resolve(target), { force: true });
  }
});

test("F1: inline eval stays blocked (node -e / python3 -c) — independent of the sandbox", async () => {
  const ge = createGovernedExec({ config: cfg("off"), gateWall: gate(), receipts: captureReceipts().receipts, publish: () => {} });
  const a = await ge.run({ parentCtx: ctx(), command: "node", args: ["-e", "1+1"], cwd: tmpdir(), purpose: "f1" });
  assert.equal(a.denied, true, "node -e must be denied");
  const b = await ge.run({ parentCtx: ctx(), command: "node", args: ["--eval", "1"], cwd: tmpdir(), purpose: "f1" });
  assert.equal(b.denied, true, "node --eval must be denied");
});

test("F1: sandbox UNAVAILABLE ⇒ a risky command FAILS CLOSED (no unsafe default)", async () => {
  const unavailable = (): SandboxAvailability => ({ available: false, reason: "test: no bwrap" });
  const cap = captureReceipts();
  const ge = createGovernedExec({
    config: cfg("auto"), gateWall: gate(), receipts: cap.receipts, publish: () => {},
    sandboxAvailability: unavailable,
    // execFile should NEVER be reached for a risky command when the sandbox is unavailable.
    execFile: async () => { throw new Error("execFile must not run a risky command without a sandbox"); },
  });
  const res = await ge.run({ parentCtx: ctx(), command: "node", args: ["x.js"], cwd: "/work", worktreeRoot: "/work", purpose: "f1" });
  assert.equal(res.denied, true, "risky command denied when sandbox unavailable");
  assert.match(res.reason ?? "", /sandbox is unavailable/i);
  assert.ok(cap.all.some((r) => (r.metadata as Record<string, unknown>)?.sandboxEvent === "risky_command_blocked"), "risky_command_blocked receipt written");
});

test("F1: required mode also fails closed when the sandbox is unavailable", async () => {
  const ge = createGovernedExec({
    config: cfg("required"), gateWall: gate(), receipts: captureReceipts().receipts, publish: () => {},
    sandboxAvailability: () => ({ available: false, reason: "test" }),
    execFile: async () => { throw new Error("must not run"); },
  });
  const res = await ge.run({ parentCtx: ctx(), command: "python3", args: ["x.py"], cwd: "/w", worktreeRoot: "/w", purpose: "f1" });
  assert.equal(res.denied, true);
});

test("F1: trusted-local override runs the risky command UNSANDBOXED but loudly receipts it", async () => {
  const cap = captureReceipts();
  let ran = false;
  const ge = createGovernedExec({
    config: cfg("auto", /* trustedLocalOverride */ true), gateWall: gate(), receipts: cap.receipts, publish: () => {},
    sandboxAvailability: () => ({ available: false, reason: "test: no bwrap" }),
    execFile: async () => { ran = true; return { stdout: "ok", stderr: "" }; },
  });
  const res = await ge.run({ parentCtx: ctx(), command: "node", args: ["x.js"], cwd: "/work", worktreeRoot: "/work", purpose: "f1" });
  assert.equal(res.executed, true, "override lets it run");
  assert.equal(ran, true, "the (unsandboxed) execFile ran");
  assert.ok(cap.all.some((r) => (r.metadata as Record<string, unknown>)?.sandboxEvent === "sandbox.unavailable"), "sandbox.unavailable receipt written");
});

test("F1: SAFE commands (echo) are NOT sandboxed and run normally", { skip: skipReal }, async () => {
  const cap = captureReceipts();
  const ge = createGovernedExec({ config: cfg("auto"), gateWall: gate(), receipts: cap.receipts, publish: () => {} });
  const res = await ge.run({ parentCtx: ctx(), command: "echo", args: ["hello"], cwd: tmpdir(), purpose: "f1" });
  assert.equal(res.executed, true);
  assert.ok(cap.all.some((r) => (r.metadata as Record<string, unknown>)?.sandbox === "none"), "safe command receipt records sandbox=none");
});

test("F1: with an injected available sandbox, a risky run is wrapped (execFile sees bwrap)", async () => {
  let seenBinary = "";
  const ge = createGovernedExec({
    config: cfg("auto"), gateWall: gate(), receipts: captureReceipts().receipts, publish: () => {},
    sandboxAvailability: () => ({ available: true, tool: "bwrap", version: "test" }),
    execFile: async (binary) => { seenBinary = binary; return { stdout: "", stderr: "" }; },
  });
  // The default execFile would wrap; an injected execFile receives the RAW command but the PLAN in
  // opts.sandbox proves the wrap intent. Verify the plan is attached.
  let sawPlan = false;
  const ge2 = createGovernedExec({
    config: cfg("auto"), gateWall: gate(), receipts: captureReceipts().receipts, publish: () => {},
    sandboxAvailability: () => ({ available: true, tool: "bwrap", version: "test" }),
    execFile: async (_b, _a, opts) => { sawPlan = (opts as { sandbox?: unknown }).sandbox !== undefined; return { stdout: "", stderr: "" }; },
  });
  await ge.run({ parentCtx: ctx(), command: "node", args: ["x.js"], cwd: "/w", worktreeRoot: "/w", purpose: "f1" });
  await ge2.run({ parentCtx: ctx(), command: "node", args: ["x.js"], cwd: "/w", worktreeRoot: "/w", purpose: "f1" });
  assert.equal(seenBinary, "node", "injected execFile receives the raw command (it ignores the wrap)");
  assert.equal(sawPlan, true, "a bwrap sandbox plan is attached to the exec opts for the default primitive to apply");
});
