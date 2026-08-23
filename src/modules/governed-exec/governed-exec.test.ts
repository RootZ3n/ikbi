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
import type { FetchLike } from "../../core/provider/providers/openai-compatible.js";
import { createGateWall, type GateWall, type GateWallEvaluateInput } from "../gate-wall/index.js";
import { createGovernedExec, type ExecFileFn } from "./exec.js";
import type { GovernedExecConfig } from "./config.js";
import type { GovExecEventPayload } from "./events.js";

const silent = () => pino({ level: "silent" });

/** A validated operation context for a caller at the given tier. */
function makeCtx(tier: string, opts: { dryRun?: boolean } = {}): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "caller-1", kind: "agent", defaultTrustTier: tier, tokenHashes: [hashToken("caller-secret")] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "caller-secret" }), { requestId: "req-1", ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}) });
}

function cfg(allowlist: string[], enabled = true): GovernedExecConfig {
  // sandbox OFF for these unit tests: they exercise gating/allowlist/policy with an INJECTED
  // execFile, not real OS-sandboxed execution (covered by sandbox.test.ts + the F1 integration
  // tests). The `sandbox` field is a contract addition (F1) — see config.ts / sandbox.ts.
  return { enabled, allowlist, execTimeoutMs: 1000, maxBuffer: 1_000_000, networkTimeoutMs: 1000, jobKillGraceMs: 5000, sandbox: { mode: "off", trustedLocalOverride: false } };
}

function fakeExecFile(result: { stdout: string; stderr: string } = { stdout: "out", stderr: "" }) {
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
    e.stderr = "boom";
    throw e;
  };
  return { fn, calls };
}

function fakeGuardedFetch(status = 200, body = "resp") {
  const calls: Array<{ url: string; init: { method: string } }> = [];
  const fn: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    return { ok: status < 400, status, json: async () => ({}), text: async () => body };
  };
  return { fn, calls };
}

function throwingGuardedFetch(message: string) {
  const calls: string[] = [];
  const fn: FetchLike = async (input) => {
    calls.push(input);
    throw new Error(message);
  };
  return { fn, calls };
}

/** A gate that delegates to the REAL gate-wall (grant→verdict) and captures inputs. */
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

/** A gate that always denies (independent of grant). */
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
  const sent: Array<EventInput<GovExecEventPayload>> = [];
  return { publish: (e: EventInput<GovExecEventPayload>) => void sent.push(e), sent, types: () => sent.map((e) => e.type) };
}

// ── allowlist (default-deny) ─────────────────────────────────────────────────

test("an un-allowlisted binary is denied; execFile is NEVER called; no gate call", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const rc = fakeReceipts();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: rc.receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "rm", args: ["-rf", "/"] });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /allowlist/);
  assert.equal(ex.calls.length, 0, "the un-allowlisted binary never ran");
  assert.equal(gate.inputs.length, 0, "fail-closed at the module — no gate call needed");
  assert.equal(rc.calls.at(-1)?.input.outcome.status, "rejected");
});

test("an allowlisted binary with an allowing gate executes", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "git", args: ["status"] });
  assert.equal(r.executed, true);
  assert.equal(r.exitCode, 0);
  assert.equal(ex.calls.length, 1);
  assert.deepEqual(ex.calls[0]?.args, ["status"]);
});

test("effect policy denies dangerous git forms and package scripts outside checks", async () => {
  for (const [command, args] of [
    ["git", ["-C", "/lab-fake", "status"]],
    ["git", ["--git-dir=.git", "status"]],
    ["git", ["--work-tree", "/lab-fake", "status"]],
    ["git", ["push", "origin", "main"]],
    ["git", ["update-ref", "refs/heads/main", "HEAD"]],
    ["git", ["branch", "-D", "main"]],
    ["git", ["branch", "-f", "main", "HEAD"]],
    ["pnpm", ["run", "build"]],
    ["npm", ["test"]],
    ["npx", ["tsx", "script.ts"]],
  ] as const) {
    const ex = fakeExecFile();
    const gate = capturingGate();
    const ge = createGovernedExec({ config: cfg(["git", "pnpm", "npm", "npx"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });
    const r = await ge.run({ parentCtx: makeCtx("verified"), command, args, purpose: "builder terminal" });
    assert.equal(r.denied, true, `${command} ${args.join(" ")} denied`);
    assert.equal(ex.calls.length, 0, "denied command never executes");
    assert.equal(gate.inputs.length, 0, "module policy denies before gate dispatch");
  }
});

test("package-manager scripts are allowed for verifier/check purposes", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const ge = createGovernedExec({ config: cfg(["pnpm"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "pnpm", args: ["test"], verifier: true, purpose: "verifier check: test" });
  assert.equal(r.executed, true);
  assert.equal(ex.calls.length, 1);
  assert.equal(gate.inputs.length, 1);
});

// ── sudo is ALWAYS gated ─────────────────────────────────────────────────────

test("sudo on an allowlisted binary at a requiresApproval tier is DENIED by the gate (sudo flows through)", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("probation"), command: "git", args: ["status"], sudo: true });
  assert.equal(r.denied, true, "probation + sudo → gate-wall denies");
  assert.equal(ex.calls.length, 0, "nothing ran");
  assert.equal(gate.inputs.length, 1, "the gate was consulted");
  const action = gate.inputs[0]?.action;
  assert.equal(action?.kind, "exec");
  assert.equal(action?.kind === "exec" ? action.sudo : undefined, true, "sudo:true reached the gate action");
});

test("sudo at a non-approval tier is allowed by the gate and executes (still gated)", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "git", args: ["status"], sudo: true });
  assert.equal(r.executed, true);
  assert.equal(gate.inputs.length, 1, "sudo still went through the gate");
  const action = gate.inputs[0]?.action;
  assert.equal(action?.kind === "exec" ? action.sudo : undefined, true);
});

// ── gate deny ────────────────────────────────────────────────────────────────

test("a gate-wall deny blocks execution; execFile is NEVER called; rejected receipt", async () => {
  const ex = fakeExecFile();
  const gate = denyingGate();
  const rc = fakeReceipts();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: rc.receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "git", args: ["status"] });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /denied by test policy/);
  assert.equal(ex.calls.length, 0);
  assert.equal(rc.calls.at(-1)?.input.outcome.status, "rejected");
});

// ── array args / no shell (structural injection prevention) ──────────────────

test("args reach execFile as a LITERAL array (no shell, no metacharacter interpretation)", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const ge = createGovernedExec({ config: cfg(["echo"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const evil = ["hello; rm -rf /", "$(whoami)", "| cat /etc/passwd", "&&reboot"];
  await ge.run({ parentCtx: makeCtx("verified"), command: "echo", args: evil });

  assert.equal(ex.calls[0]?.binary, "echo");
  assert.deepEqual(ex.calls[0]?.args, evil, "metacharacters passed verbatim as array elements, not interpreted");
  assert.ok(!("shell" in (ex.calls[0]?.opts ?? {})), "execFile is invoked with NO shell option");
});

test("exec children receive a scrubbed env allowlist only", async () => {
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const oldLang = process.env.LANG;
  const oldSecret = process.env.IKBI_SECRET_TEST_VALUE;
  process.env.PATH = "/usr/bin";
  process.env.HOME = "/home/test";
  process.env.LANG = "C.UTF-8";
  process.env.IKBI_SECRET_TEST_VALUE = "do-not-leak";
  try {
    const ex = fakeExecFile();
    const ge = createGovernedExec({ config: cfg(["echo"]), gateWall: capturingGate().gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });
    await ge.run({ parentCtx: makeCtx("verified"), command: "echo", args: ["hi"] });
    const childEnv = (ex.calls[0]?.opts.env ?? {}) as NodeJS.ProcessEnv;
    // The allowlisted host vars pass through; the process SECRET does NOT leak (the security property).
    assert.equal(childEnv.PATH, "/usr/bin");
    assert.equal(childEnv.HOME, "/home/test");
    assert.equal(childEnv.LANG, "C.UTF-8");
    assert.equal(childEnv.IKBI_SECRET_TEST_VALUE, undefined, "process secrets must not leak into the child env");
    // Git hardening is injected for EVERY governed command (harmless to non-git): repo hooks disabled,
    // system git config ignored. (Constant flags, not host secrets.)
    assert.equal(childEnv.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(childEnv.GIT_CONFIG_KEY_0, "core.hooksPath");
    assert.equal(childEnv.GIT_CONFIG_VALUE_0, "/dev/null");
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldLang === undefined) delete process.env.LANG; else process.env.LANG = oldLang;
    if (oldSecret === undefined) delete process.env.IKBI_SECRET_TEST_VALUE; else process.env.IKBI_SECRET_TEST_VALUE = oldSecret;
  }
});

test("F2: a risky command under sandbox mode=off runs but is LOUDLY receipted (never a silent skip)", async () => {
  const ex = fakeExecFile();
  const rc = fakeReceipts();
  // cfg() sets sandbox.mode "off"; python3 is a risky interpreter (does its own filesystem syscalls).
  const ge = createGovernedExec({ config: cfg(["python3"]), gateWall: capturingGate().gateWall, execFile: ex.fn, receipts: rc.receipts, publish: () => {} });
  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "python3", args: ["script.py"] });
  assert.equal(r.executed, true, "mode=off still runs the command (unsandboxed)");
  // The unsandboxed run is recorded loudly — 'off' cannot masquerade as safe in the audit trail.
  const loud = rc.calls.some((c) => /SANDBOX OFF/.test((c.input.outcome as { detail?: string }).detail ?? ""));
  assert.ok(loud, "a loud 'SANDBOX OFF' receipt is written for the risky unsandboxed command");
});

test("operator-allowed interpreters still reject direct code-eval flags", async () => {
  const ex = fakeExecFile();
  const ge = createGovernedExec({ config: cfg(["node", "npm", "pnpm", "python3", "ruby", "perl", "php"]), gateWall: capturingGate().gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });
  for (const [command, args] of [
    ["node", ["-e", "process.env"]],
    ["node", ["-p", "1+1"]],
    // Codex C4: python3 -c is the reachable vector (python3 is on the default allowlist for pytest).
    ["python3", ["-c", "open('/root/.ssh/id_rsa').read()"]],
    ["ruby", ["-e", "puts 1"]],
    ["perl", ["-e", "print 1"]],
    ["php", ["-r", "echo 1;"]],
  ] as const) {
    const r = await ge.run({ parentCtx: makeCtx("verified"), command, args });
    assert.equal(r.denied, true, `${command} ${args.join(" ")} should be denied`);
  }
  assert.equal(ex.calls.length, 0);
});

test("python3 -m <module> (e.g. pytest) is NOT an eval flag — stays allowed", async () => {
  const ex = fakeExecFile();
  const ge = createGovernedExec({ config: cfg(["python3"]), gateWall: capturingGate().gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });
  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "python3", args: ["-m", "pytest", "-q"] });
  assert.notEqual(r.denied, true, "python3 -m pytest must not be denied as inline-eval");
});

// ── curl / HTTP through the egress guard ─────────────────────────────────────

test("fetch routes through the guarded fetch (egress), NOT the curl binary", async () => {
  const ex = fakeExecFile();
  const gf = fakeGuardedFetch(200, "body");
  const ge = createGovernedExec({ config: cfg(["git"]), guardedFetch: gf.fn, execFile: ex.fn, gateWall: capturingGate().gateWall, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await ge.fetch({ parentCtx: makeCtx("verified"), url: "https://example.com/x", method: "GET" });
  assert.equal(r.executed, true);
  assert.equal(r.status, 200);
  assert.equal(gf.calls.length, 1, "went through the egress guard");
  assert.equal(ex.calls.length, 0, "did NOT shell out to curl");
});

test("a guard-blocked URL is surfaced (denied), not swallowed", async () => {
  const gf = throwingGuardedFetch("egress blocked (ip_internal): 10.0.0.1");
  const ge = createGovernedExec({ config: cfg(["git"]), guardedFetch: gf.fn, execFile: fakeExecFile().fn, gateWall: capturingGate().gateWall, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await ge.fetch({ parentCtx: makeCtx("verified"), url: "http://10.0.0.1/", method: "GET" });
  assert.equal(r.denied, true);
  assert.equal(r.executed, false);
  assert.match(r.reason ?? "", /egress blocked/);
});

// ── dryRun ───────────────────────────────────────────────────────────────────

test("dryRun reports intent + the gate decision and executes NOTHING", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const rc = fakeReceipts();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: rc.receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("verified", { dryRun: true }), command: "git", args: ["status"] });
  assert.equal(r.executed, false);
  assert.match(r.reason ?? "", /dry-run/);
  assert.equal(ex.calls.length, 0, "no execFile under dry-run");
  assert.equal(gate.inputs.length, 1, "the gate decision was still computed + reported");
  assert.equal(rc.calls.at(-1)?.input.metadata?.dryRun, true);
});

test("dryRun fetch performs NO network call", async () => {
  const gf = fakeGuardedFetch();
  const ge = createGovernedExec({ config: cfg(["git"]), guardedFetch: gf.fn, execFile: fakeExecFile().fn, gateWall: capturingGate().gateWall, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await ge.fetch({ parentCtx: makeCtx("verified", { dryRun: true }), url: "https://example.com/", method: "GET" });
  assert.equal(r.executed, false);
  assert.match(r.reason ?? "", /dry-run/);
  assert.equal(gf.calls.length, 0, "no fetch under dry-run");
});

// ── fail-closed refusals ─────────────────────────────────────────────────────

test("a disabled executor denies; no gate call; no exec", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const ge = createGovernedExec({ config: cfg(["git"], false), gateWall: gate.gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "git", args: ["status"] });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /disabled/);
  assert.equal(gate.inputs.length, 0);
  assert.equal(ex.calls.length, 0);
});

test("a non-validated identity is denied; no exec", async () => {
  const ex = fakeExecFile();
  const gate = capturingGate();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: gate.gateWall, execFile: ex.fn, receipts: fakeReceipts().receipts, publish: () => {} });

  const spoof = {
    contractVersion: "1.1.0",
    identity: { kind: "agent", identity: { agentId: "spoof", trustTier: "operator" }, authMethod: "agent_token", resolvedAt: 0 },
    startedAt: 0,
  } as unknown as OperationContext;
  const r = await ge.run({ parentCtx: spoof, command: "git", args: ["status"] });
  assert.equal(r.denied, true);
  assert.match(r.reason ?? "", /validated identity/);
  assert.equal(ex.calls.length, 0);
});

// ── receipts + events do NOT leak full args ──────────────────────────────────

test("an executed command writes an attributed exec receipt with argCount+sudo+exitCode; full args NOT logged", async () => {
  const ex = fakeExecFile();
  const rc = fakeReceipts();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: capturingGate().gateWall, execFile: ex.fn, receipts: rc.receipts, publish: () => {} });

  await ge.run({ parentCtx: makeCtx("verified"), command: "git", args: ["log", "--grep", "SUPERSECRET-VALUE"] });
  const last = rc.calls.at(-1)!;
  assert.equal(last.input.metadata?.action, "exec");
  assert.equal(last.input.metadata?.argCount, 3);
  assert.equal(last.input.metadata?.sudo, false);
  assert.equal(last.input.metadata?.exitCode, 0);
  assert.equal(last.identity.agentId, "caller-1", "receipt attributed to the caller identity");
  assert.ok(!JSON.stringify(last.input).includes("SUPERSECRET-VALUE"), "full args are NOT logged in the receipt");
});

test("events never carry the full args", async () => {
  const ev = captureEvents();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: capturingGate().gateWall, execFile: fakeExecFile().fn, receipts: fakeReceipts().receipts, publish: ev.publish });

  await ge.run({ parentCtx: makeCtx("verified"), command: "git", args: ["log", "--grep", "SUPERSECRET-VALUE"] });
  for (const e of ev.sent) assert.equal(e.source, "governed-exec");
  assert.ok(ev.types().includes("govexec.executed"));
  assert.ok(!JSON.stringify(ev.sent).includes("SUPERSECRET-VALUE"), "full args are NOT logged in events");
});

test("a command that exits non-zero is reported executed:true with the exit code + a failure receipt", async () => {
  const ex = failingExecFile(2);
  const rc = fakeReceipts();
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: capturingGate().gateWall, execFile: ex.fn, receipts: rc.receipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx("verified"), command: "git", args: ["status"] });
  assert.equal(r.executed, true, "it ran (exit non-zero is not a deny)");
  assert.equal(r.exitCode, 2);
  assert.equal(rc.calls.at(-1)?.input.outcome.status, "failure");
});
