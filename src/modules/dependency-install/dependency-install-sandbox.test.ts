/**
 * ikbi dependency-install — SANDBOX + script-policy tests (F1 install hardening).
 *
 * The install path runs `pnpm install` / `npm ci`, whose lifecycle scripts (postinstall) are
 * arbitrary code execution — the F1 escape vector applied to dependency install. This proves:
 *   • scripts are disabled by default (`--ignore-scripts`); only an explicit opt-in runs them;
 *   • a risky install (scripts enabled) runs ONLY inside the bwrap sandbox; with no sandbox it FAILS
 *     CLOSED (no unsafe default) unless the explicit trusted-local override is set;
 *   • a default install (scripts off) is safe even without a sandbox (no untrusted code runs);
 *   • receipts record the sandbox / script / network policy;
 *   • [real bwrap] a package postinstall that tries to escape the worktree is CONTAINED on the host.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { pino } from "pino";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ReceiptInput } from "../../core/receipt/contract.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { createGateWall } from "../gate-wall/index.js";
import { detectSandbox, type SandboxAvailability } from "../governed-exec/sandbox.js";
import { createDependencyInstall, type ExecFileFn, type ReadLockfileFn } from "./install.js";
import type { DependencyInstallConfig } from "./config.js";

const NPM_REGISTRY = "https://registry.npmjs.org/";
const SANDBOX = detectSandbox();
const skipReal = SANDBOX.available ? false : `bubblewrap unavailable: ${SANDBOX.reason ?? "no sandbox"}`;

function ctx(): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "caller-1", kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken("caller-secret")] }] }),
    logger: pino({ level: "silent" }), now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "caller-secret" }), { requestId: "req-di" });
}
function cfg(over: Partial<DependencyInstallConfig> = {}): DependencyInstallConfig {
  return { enabled: true, registryAllowlist: [NPM_REGISTRY], defaultPackageManager: "pnpm", installTimeoutMs: 60_000, maxBuffer: 8_000_000, allowScripts: false, sandboxMode: "auto", sandboxTrustedLocalOverride: false, ...over };
}
const lockfile: ReadLockfileFn = () => "lockfileVersion: 9\n";
const gate = () => createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} });
function recs() { const calls: ReceiptInput[] = []; return { receipts: { append: async (i: ReceiptInput) => { calls.push(i); return {}; } }, calls }; }
function spyExec(result = { stdout: "ok", stderr: "" }) {
  const calls: Array<{ binary: string; args: readonly string[]; opts: Record<string, unknown> }> = [];
  const fn: ExecFileFn = async (binary, args, opts) => { calls.push({ binary, args, opts: opts as Record<string, unknown> }); return result; };
  return { fn, calls };
}
const ws = (path: string): WorkspaceHandle => ({ id: "wsx", targetRepo: "/repo", baseBranch: "main", baseRef: "d", scratchBranch: "ikbi/ws/wsx", path, identity: { agentId: "caller-1" }, state: "allocated", createdAt: 1000 });
const meta = (r: ReceiptInput) => (r.metadata ?? {}) as Record<string, unknown>;

test("scripts are DISABLED by default (--ignore-scripts); enabled only on opt-in", async () => {
  const off = spyExec();
  await createDependencyInstall({ config: cfg({ sandboxMode: "off" }), gateWall: gate(), execFile: off.fn, readLockfile: lockfile, receipts: recs().receipts, publish: () => {} })
    .run({ parentCtx: ctx(), workspace: ws("/tmp/x") });
  assert.ok(off.calls[0]?.args.includes("--ignore-scripts"), "default install passes --ignore-scripts");

  const on = spyExec();
  await createDependencyInstall({ config: cfg({ sandboxMode: "off", allowScripts: true }), gateWall: gate(), execFile: on.fn, readLockfile: lockfile, receipts: recs().receipts, publish: () => {} })
    .run({ parentCtx: ctx(), workspace: ws("/tmp/x") });
  assert.ok(!on.calls[0]?.args.includes("--ignore-scripts"), "allowScripts opt-in does NOT pass --ignore-scripts");
});

test("a bwrap sandbox plan is attached when the sandbox is available", async () => {
  const ex = spyExec();
  await createDependencyInstall({
    config: cfg(), gateWall: gate(), execFile: ex.fn, readLockfile: lockfile, receipts: recs().receipts, publish: () => {},
    sandboxAvailability: (): SandboxAvailability => ({ available: true, tool: "bwrap", version: "t" }),
    storeDirs: () => [],
  }).run({ parentCtx: ctx(), workspace: ws("/tmp/x") });
  const plan = (ex.calls[0]?.opts as { sandbox?: { mode: string; networkAllowed: boolean } }).sandbox;
  assert.equal(plan?.mode, "bwrap", "install carries a bwrap sandbox plan");
  assert.equal(plan?.networkAllowed, true, "install sandbox keeps network (registry fetch)");
});

test("sandbox UNAVAILABLE + scripts ENABLED ⇒ FAILS CLOSED (no unsafe default)", async () => {
  const ex = spyExec();
  const r = await createDependencyInstall({
    config: cfg({ allowScripts: true }), gateWall: gate(), readLockfile: lockfile, receipts: recs().receipts, publish: () => {},
    execFile: async () => { throw new Error("must NOT run a script-enabled install without a sandbox"); },
    sandboxAvailability: () => ({ available: false, reason: "test: no bwrap" }),
  }).run({ parentCtx: ctx(), workspace: ws("/tmp/x") });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /sandbox is unavailable/i);
  assert.equal(ex.calls.length, 0);
});

test("sandbox UNAVAILABLE + scripts DISABLED (default) ⇒ proceeds (no untrusted code runs)", async () => {
  const ex = spyExec();
  const r = await createDependencyInstall({
    config: cfg(), gateWall: gate(), execFile: ex.fn, readLockfile: lockfile, receipts: recs().receipts, publish: () => {},
    sandboxAvailability: () => ({ available: false, reason: "test: no bwrap" }),
  }).run({ parentCtx: ctx(), workspace: ws("/tmp/x") });
  assert.equal(r.installed, true, "scripts-disabled install proceeds without a sandbox");
  assert.ok(ex.calls[0]?.args.includes("--ignore-scripts"));
});

test("sandboxMode=required + unavailable ⇒ FAILS CLOSED even with scripts disabled", async () => {
  const r = await createDependencyInstall({
    config: cfg({ sandboxMode: "required" }), gateWall: gate(), readLockfile: lockfile, receipts: recs().receipts, publish: () => {},
    execFile: async () => { throw new Error("must not run"); },
    sandboxAvailability: () => ({ available: false, reason: "test" }),
  }).run({ parentCtx: ctx(), workspace: ws("/tmp/x") });
  assert.equal(r.denied, true);
});

test("trusted-local override runs a script-enabled install UNSANDBOXED but receipts it", async () => {
  const ex = spyExec();
  const rc = recs();
  await createDependencyInstall({
    config: cfg({ allowScripts: true, sandboxTrustedLocalOverride: true }), gateWall: gate(), execFile: ex.fn, readLockfile: lockfile, receipts: rc.receipts, publish: () => {},
    sandboxAvailability: () => ({ available: false, reason: "test" }),
  }).run({ parentCtx: ctx(), workspace: ws("/tmp/x") });
  assert.equal(ex.calls.length, 1, "override lets it run");
  assert.equal((ex.calls[0]?.opts as { sandbox?: unknown }).sandbox, undefined, "ran unsandboxed");
  assert.ok(rc.calls.some((r) => meta(r).sandbox === "unavailable"), "receipt records sandbox=unavailable");
});

test("receipts record sandbox / script / network policy", async () => {
  const rc = recs();
  await createDependencyInstall({
    config: cfg(), gateWall: gate(), execFile: spyExec().fn, readLockfile: lockfile, receipts: rc.receipts, publish: () => {},
    sandboxAvailability: (): SandboxAvailability => ({ available: true, tool: "bwrap", version: "t" }), storeDirs: () => [],
  }).run({ parentCtx: ctx(), workspace: ws("/tmp/x") });
  const success = rc.calls.find((r) => r.outcome.status === "success");
  assert.equal(meta(success!).sandbox, "bwrap");
  assert.equal(meta(success!).scriptPolicy, "ignore-scripts");
  assert.equal(meta(success!).networkPolicy, "registry-only");
});

// ── REAL bwrap: a postinstall escape is contained on the host ────────────────
test("[bwrap] a package postinstall cannot escape the worktree (rel + abs)", { skip: skipReal }, async () => {
  const wt = mkdtempSync(join(tmpdir(), "ikbi-di-esc-"));
  const relHost = resolve(wt, "..", "..", "DI_REL_ESCAPE");
  const absHost = join(tmpdir(), "DI_ABS_ESCAPE_" + process.pid);
  rmSync(absHost, { force: true }); rmSync(relHost, { force: true });
  // A package whose postinstall tries to escape; generate a real frozen lockfile.
  writeFileSync(join(wt, "package.json"), JSON.stringify({
    name: "di-esc", version: "0.1.0",
    scripts: { postinstall: `node -e "try{require('fs').writeFileSync('../../DI_REL_ESCAPE','x')}catch(e){}; try{require('fs').writeFileSync(${JSON.stringify(absHost)},'x')}catch(e){}"` },
  }));
  spawnSync("pnpm", ["install", "--lockfile-only"], { cwd: wt, encoding: "utf8", timeout: 60_000 });
  try {
    // Scripts ENABLED so the postinstall actually runs — and must still be contained by the sandbox.
    const r = await createDependencyInstall({ config: cfg({ allowScripts: true }), gateWall: gate(), readLockfile: (p, n) => { try { return readFileSync(join(p, n), "utf8"); } catch { return undefined; } }, receipts: recs().receipts, publish: () => {} })
      .run({ parentCtx: ctx(), workspace: ws(wt) });
    // The install may pass or fail (no deps), but the host must be intact either way.
    assert.equal(existsSync(absHost), false, "absolute /tmp escape contained");
    assert.equal(existsSync(relHost), false, "relative ../../ escape contained");
    assert.ok(r !== undefined);
  } finally {
    rmSync(wt, { recursive: true, force: true }); rmSync(absHost, { force: true }); rmSync(relHost, { force: true });
  }
});
