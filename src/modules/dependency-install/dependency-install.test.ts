import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import type { EventInput } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ReceiptInput } from "../../core/receipt/contract.js";
import type { PromoteGovernance } from "../../core/workspace/contract.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { createGateWall, type GateWall, type GateWallEvaluateInput } from "../gate-wall/index.js";
import { createDependencyInstall, type ExecFileFn, type ReadLockfileFn } from "./install.js";
import type { DependencyInstallConfig } from "./config.js";
import type { DepInstallEventPayload } from "./events.js";

const silent = () => pino({ level: "silent" });

function makeCtx(tier: string, opts: { dryRun?: boolean } = {}): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "caller-1", kind: "agent", defaultTrustTier: tier, tokenHashes: [hashToken("caller-secret")] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "caller-secret" }), { requestId: "req-1", ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}) });
}

const WORKSPACE: WorkspaceHandle = {
  id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef",
  scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "caller-1" }, state: "allocated", createdAt: 1000,
};

const NPM_REGISTRY = "https://registry.npmjs.org/";

function cfg(over: Partial<DependencyInstallConfig> = {}): DependencyInstallConfig {
  return { enabled: true, registryAllowlist: [NPM_REGISTRY], defaultPackageManager: "pnpm", installTimeoutMs: 1000, maxBuffer: 1_000_000, ...over };
}

function fakeExecFile(result: { stdout: string; stderr: string } = { stdout: "deps installed", stderr: "" }) {
  const calls: Array<{ binary: string; args: readonly string[]; opts: Record<string, unknown> }> = [];
  const fn: ExecFileFn = async (binary, args, opts) => {
    calls.push({ binary, args, opts: opts as Record<string, unknown> });
    return result;
  };
  return { fn, calls };
}

function failingExecFile(code: number) {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  const fn: ExecFileFn = async (binary, args) => {
    calls.push({ binary, args });
    const e = new Error("exit") as Error & { code: number; stdout: string; stderr: string };
    e.code = code;
    e.stdout = "";
    e.stderr = "lockfile out of date";
    throw e;
  };
  return { fn, calls };
}

/** A lockfile reader returning fixed contents (carrying a recognizable token). */
function fakeLockfile(contents = "lockfileVersion: 9\nintegrity: sha512-LOCKFILE-TOKEN-7\n") {
  const fn: ReadLockfileFn = () => contents;
  return { fn, contents };
}
const missingLockfile: ReadLockfileFn = () => undefined;

function capturingGate() {
  const real = createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} });
  const inputs: GateWallEvaluateInput[] = [];
  const gateWall: GateWall = {
    evaluate: async (input) => {
      inputs.push(input);
      return real.evaluate(input);
    },
  };
  return { gateWall, inputs };
}

function denyingGate() {
  const inputs: GateWallEvaluateInput[] = [];
  const gateWall: GateWall = {
    evaluate: async (input): Promise<PromoteGovernance> => {
      inputs.push(input);
      return { allow: false, reason: "denied by test policy", gateId: "g1" };
    },
  };
  return { gateWall, inputs };
}

function fakeReceipts() {
  const calls: Array<{ input: ReceiptInput; identity: AgentIdentity }> = [];
  const receipts = {
    append: async (input: ReceiptInput, identity: AgentIdentity): Promise<unknown> => {
      calls.push({ input, identity });
      return {};
    },
  };
  return { receipts, calls };
}

function captureEvents() {
  const sent: Array<EventInput<DepInstallEventPayload>> = [];
  return { publish: (e: EventInput<DepInstallEventPayload>) => void sent.push(e), sent, types: () => sent.map((e) => e.type) };
}

// ── lockfile-only (frozen) ───────────────────────────────────────────────────

test("pnpm install runs with --frozen-lockfile (no new resolutions)", async () => {
  const ex = fakeExecFile();
  const di = createDependencyInstall({ config: cfg(), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  assert.equal(r.installed, true);
  assert.equal(ex.calls[0]?.binary, "pnpm");
  assert.ok(ex.calls[0]?.args.includes("--frozen-lockfile"), "frozen-lockfile flag passed");
  assert.equal(r.mode, "frozen-lockfile");
});

test("npm install runs with ci (frozen)", async () => {
  const ex = fakeExecFile();
  const di = createDependencyInstall({ config: cfg({ defaultPackageManager: "npm" }), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE, packageManager: "npm" });
  assert.equal(ex.calls[0]?.binary, "npm");
  assert.ok(ex.calls[0]?.args.includes("ci"), "npm ci (frozen) used");
  assert.equal(r.mode, "ci");
});

test("a missing lockfile is denied; execFile NEVER called (frozen needs a lockfile)", async () => {
  const ex = fakeExecFile();
  const di = createDependencyInstall({ config: cfg(), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: missingLockfile, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /lockfile/);
  assert.equal(ex.calls.length, 0);
});

// ── registry allowlist (default-deny) ────────────────────────────────────────

test("no allowlisted registry → denied; execFile NEVER called", async () => {
  const ex = fakeExecFile();
  const di = createDependencyInstall({ config: cfg({ registryAllowlist: [] }), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /default-deny|allowlist/);
  assert.equal(ex.calls.length, 0);
});

test("an allowlisted registry is passed as --registry to execFile", async () => {
  const ex = fakeExecFile();
  const di = createDependencyInstall({ config: cfg(), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: fakeReceipts().receipts, publish: () => {} });

  await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  const args = ex.calls[0]?.args ?? [];
  const i = args.indexOf("--registry");
  assert.ok(i >= 0, "--registry flag present");
  assert.equal(args[i + 1], NPM_REGISTRY);
});

test("a non-allowlisted registry request is denied; execFile NEVER called", async () => {
  const ex = fakeExecFile();
  const di = createDependencyInstall({ config: cfg(), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE, registry: "https://evil.example.com/" });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /not on the allowlist/);
  assert.equal(ex.calls.length, 0);
});

// ── gate before install ──────────────────────────────────────────────────────

test("gate-wall is evaluated (kind:exec) before execFile; a deny blocks the install", async () => {
  const ex = fakeExecFile();
  const gate = denyingGate();
  const rc = fakeReceipts();
  const di = createDependencyInstall({ config: cfg(), gateWall: gate.gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: rc.receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  assert.equal(r.denied, true);
  assert.equal(gate.inputs.length, 1);
  assert.equal(gate.inputs[0]?.action.kind, "exec");
  assert.equal(ex.calls.length, 0, "a denied install never execs");
  assert.equal(rc.calls.at(-1)?.input.outcome.status, "rejected");
});

// ── array args / no shell ────────────────────────────────────────────────────

test("execFile is called with (pm, argsArray) and NO shell option", async () => {
  const ex = fakeExecFile();
  const di = createDependencyInstall({ config: cfg(), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: fakeReceipts().receipts, publish: () => {} });

  await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  assert.deepEqual(ex.calls[0]?.args, ["install", "--frozen-lockfile", "--registry", NPM_REGISTRY]);
  assert.ok(!("shell" in (ex.calls[0]?.opts ?? {})), "no shell option");
  assert.equal(ex.calls[0]?.opts.cwd, WORKSPACE.path, "scoped to the workspace worktree");
});

// ── rich receipt (lockfile hash + registry + mode + exit), no lockfile contents ──

test("the receipt carries lockfile hash + registry + mode + exit code; lockfile CONTENTS not logged", async () => {
  const ex = fakeExecFile();
  const rc = fakeReceipts();
  const ev = captureEvents();
  const lf = fakeLockfile(); // contents carry LOCKFILE-TOKEN-7
  const di = createDependencyInstall({ config: cfg(), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: lf.fn, receipts: rc.receipts, publish: ev.publish });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  const meta = rc.calls.at(-1)?.input.metadata ?? {};
  assert.equal(typeof meta.lockfileHash, "string");
  assert.equal((meta.lockfileHash as string).length, 64, "sha-256 hex");
  assert.equal(meta.lockfileHash, r.lockfileHash);
  assert.equal(meta.registry, NPM_REGISTRY);
  assert.equal(meta.mode, "frozen-lockfile");
  assert.equal(meta.exitCode, 0);
  assert.equal(rc.calls.at(-1)?.identity.agentId, "caller-1");
  // lockfile CONTENTS never logged (only its hash).
  assert.ok(!JSON.stringify(rc.calls).includes("LOCKFILE-TOKEN-7"), "lockfile contents NOT in the receipt");
  assert.ok(!JSON.stringify(ev.sent).includes("LOCKFILE-TOKEN-7"), "lockfile contents NOT in events");
});

// ── dryRun ───────────────────────────────────────────────────────────────────

test("dryRun reports intent + gate decision + lockfile hash and executes NOTHING", async () => {
  const ex = fakeExecFile();
  const rc = fakeReceipts();
  const gate = capturingGate();
  const di = createDependencyInstall({ config: cfg(), gateWall: gate.gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: rc.receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified", { dryRun: true }), workspace: WORKSPACE });
  assert.equal(r.installed, false);
  assert.match(r.reason ?? "", /dry-run/);
  assert.equal(typeof r.lockfileHash, "string");
  assert.equal(ex.calls.length, 0, "no execFile under dry-run");
  assert.equal(gate.inputs.length, 1, "the gate decision was computed + reported");
  assert.equal(rc.calls.at(-1)?.input.metadata?.dryRun, true);
});

// ── fail-closed refusals ─────────────────────────────────────────────────────

test("a disabled installer denies; no gate; no exec", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const di = createDependencyInstall({ config: cfg({ enabled: false }), gateWall: gate.gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /disabled/);
  assert.equal(gate.inputs.length, 0);
  assert.equal(ex.calls.length, 0);
});

test("a non-validated identity is denied; no exec", async () => {
  const ex = fakeExecFile();
  const di = createDependencyInstall({ config: cfg(), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const spoof = {
    contractVersion: "1.1.0",
    identity: { kind: "agent", identity: { agentId: "spoof", trustTier: "operator" }, authMethod: "agent_token", resolvedAt: 0 },
    startedAt: 0,
  } as unknown as OperationContext;
  const r = await di.run({ parentCtx: spoof, workspace: WORKSPACE });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /validated identity/);
  assert.equal(ex.calls.length, 0);
});

// ── non-zero exit reported (not thrown) ──────────────────────────────────────

test("a failing install is reported installed:false with the exit code + a failure receipt (not thrown)", async () => {
  const ex = failingExecFile(1);
  const rc = fakeReceipts();
  const di = createDependencyInstall({ config: cfg(), gateWall: capturingGate().gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: rc.receipts, publish: () => {} });

  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE });
  assert.equal(r.installed, false);
  assert.equal(r.denied, undefined, "it ran and failed — not a policy deny");
  assert.equal(r.exitCode, 1);
  assert.equal(rc.calls.at(-1)?.input.outcome.status, "failure");
});

// ── fail-closed on an unsupported package manager (Hermes L1) ────────────────

test("an unsupported packageManager (caller bypassing the TS type) is denied, NOT thrown; no gate, no exec", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const rc = fakeReceipts();
  const di = createDependencyInstall({ config: cfg(), gateWall: gate.gateWall, execFile: ex.fn, readLockfile: fakeLockfile().fn, receipts: rc.receipts, publish: () => {} });

  // "yarn" is not in PM_SPECS — a crafted/JS caller could reach this past the type.
  const r = await di.run({ parentCtx: makeCtx("verified"), workspace: WORKSPACE, packageManager: "yarn" as never });
  assert.equal(r.denied, true, "graceful deny, not a thrown TypeError");
  assert.match(r.reason ?? "", /unsupported package manager/);
  assert.equal(gate.inputs.length, 0, "the guard is before the gate — no gate call");
  assert.equal(ex.calls.length, 0, "no execFile");
  assert.equal(rc.calls.at(-1)?.input.outcome.status, "rejected", "a rejected receipt is written");
});
