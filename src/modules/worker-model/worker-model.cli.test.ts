import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { commands } from "../../cli/registry.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, type TrustDecision } from "../../core/trust/index.js";
import { TRUST_FLOOR } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createGateWall } from "../gate-wall/index.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { WORKER_ROLES, WorkerError, type RoleContext, type RoleFn, type WorkerResult, type WorkerRole, type WorkerTask } from "./contract.js";
// Importing cli.js registers the `build` command at module load.
import { createWorkerCli, parseBuildArgs, productionRoleClaim } from "./cli.js";

const silent = () => pino({ level: "silent" });
const OPERATOR_TOKEN = "operator-token-value";
const WORKER_TOKEN = "worker-token-value";

/** A resolver over operator + worker agents at chosen tiers (the real identity path). */
function makeResolver(operatorTier: string, workerTier: string) {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({
      agents: [
        { agentId: "lead", kind: "agent", functionalRole: "lead", defaultTrustTier: operatorTier, tokenHashes: [hashToken(OPERATOR_TOKEN)] },
        { agentId: "worker", kind: "agent", functionalRole: "worker", defaultTrustTier: workerTier, tokenHashes: [hashToken(WORKER_TOKEN)] },
      ],
    }),
    logger: silent(),
    now: () => 1000,
  });
  return (claim: { token?: string }) => resolver.resolve(claim);
}

/** Capturing role set: records each RoleContext; integrator returns a PROMOTE decision. */
function capturingRoles() {
  const seen: RoleContext[] = [];
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async (ctx) => {
      seen.push(ctx);
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", rationale: "test", evaluation: { approved: true } } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { seen, roles };
}

function fakeWorkspaceHandle(): WorkspaceHandle {
  return { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "lead" }, state: "allocated", createdAt: 1000 };
}

/** Workspaces fake that HONORS governance at promote + captures the verdict. No real git. */
function governanceWorkspaces() {
  let captured: PromoteGovernance | undefined;
  const calls = { promote: 0, discard: 0 };
  const handle = fakeWorkspaceHandle();
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h, a): Promise<PromoteResult> => {
      calls.promote += 1;
      captured = a.governance;
      return a.governance?.allow
        ? { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }
        : { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", reason: "governance denied" };
    },
    discard: async (h): Promise<DiscardResult> => {
      calls.discard += 1;
      return { workspaceId: h.id, removed: true };
    },
  };
  return { workspaces, governance: () => captured, calls };
}

const fakeTrust = () => ({
  recordOutcome: async (i: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => {
    const tier = asTier(i.defaultTrustTier, TRUST_FLOOR);
    return { agentId: i.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) };
  },
});
const fakeReceipts = () => ({ append: async (_i: unknown, _id: AgentIdentity): Promise<unknown> => ({}) });
const noopBus = () => ({
  publish: <P>(input: P) => ({ ...(input as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown,
  subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
  flush: async () => {},
});

const ENABLED = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };

/** Build a REAL orchestrator wired with the production roleClaim + REAL gate-wall + fakes. */
function realOrchestrator(operatorTier: string, workerTier: string) {
  const resolveIdentity = makeResolver(operatorTier, workerTier);
  const cap = capturingRoles();
  const ws = governanceWorkspaces();
  const realGateWall = createGateWall({ receipts: fakeReceipts(), publish: () => {} }); // REAL evaluator
  let gateDecision: PromoteGovernance | undefined;
  const gateWall = {
    evaluate: async (...args: Parameters<typeof realGateWall.evaluate>): Promise<PromoteGovernance> => {
      gateDecision = await realGateWall.evaluate(...args);
      return gateDecision;
    },
  };
  const orchestrator = createOrchestrator({
    config: ENABLED,
    resolveIdentity,
    roleClaim: productionRoleClaim(WORKER_TOKEN), // PRODUCTION shared-worker claim
    roles: cap.roles,
    workspaces: ws.workspaces,
    gateWall,
    trust: fakeTrust(),
    receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    invokeModel: async () => {
      throw new Error("invokeModel not used (capturing roles)");
    },
  });
  return { orchestrator, resolveIdentity, cap, ws, gateDecision: () => gateDecision };
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

// ── registration ─────────────────────────────────────────────────────────────

test("build is registered as a CLI command (no built-in collision)", () => {
  assert.ok(commands.has("build"));
  for (const b of ["version", "models", "providers", "help"]) assert.notEqual(b, "build");
});

test("productionRoleClaim returns the worker token for ALL roles; throws fail-closed when unset", () => {
  const claim = productionRoleClaim(WORKER_TOKEN);
  for (const r of WORKER_ROLES) assert.deepEqual(claim(r), { token: WORKER_TOKEN });
  assert.throws(() => productionRoleClaim(undefined)("scout"), (e: unknown) => e instanceof WorkerError && e.kind === "config");
});

test("parseBuildArgs extracts --repo and leaves the goal", () => {
  assert.deepEqual(parseBuildArgs(["fix", "the", "bug", "--repo", "/r"]), { repo: "/r", rest: ["fix", "the", "bug"] });
  assert.deepEqual(parseBuildArgs(["g", "--repo=/x"]), { repo: "/x", rest: ["g"] });
  assert.deepEqual(parseBuildArgs(["just", "a", "goal"]), { rest: ["just", "a", "goal"] });
});

test("parseBuildArgs parses --yes / -y (skip the Socratic interview)", () => {
  assert.deepEqual(parseBuildArgs(["fix", "it", "--yes"]), { yes: true, rest: ["fix", "it"] });
  assert.deepEqual(parseBuildArgs(["fix", "it", "-y"]), { yes: true, rest: ["fix", "it"] });
  // absent ⇒ no `yes` key (so callers see undefined, the interview default)
  assert.deepEqual(parseBuildArgs(["fix", "it"]), { rest: ["fix", "it"] });
  // composes with the other flags
  assert.deepEqual(parseBuildArgs(["g", "--repo=/x", "-y", "--cost"]), { repo: "/x", cost: true, yes: true, rest: ["g"] });
});

// ── --yes SKIPS the blocking Socratic interview (Fix 1) ──────────────────────

test("--yes skips the interactive interview prompt even for an ambiguous goal", () => {
  // "fix it" is maximally ambiguous (vague verb + pronoun + no target) ⇒ would normally
  // trigger the interview. With --yes (and even with interactive:true) the prompt must NOT fire.
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  let promptCalls = 0;
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true, // a TTY would normally prompt …
    prompt: async () => { promptCalls += 1; return ""; },
  });
  return cli.build(["fix", "it", "--yes"]).then(() => {
    assert.equal(promptCalls, 0, "the interview prompt was NOT shown under --yes");
    assert.equal(cap2.exit, undefined, "clean run");
    const summary = JSON.parse(cap2.out); // out is ONLY the summary — no interview text leaked
    assert.equal(summary.outcome, "success");
  });
});

test("without --yes, an interactive session DOES prompt the interview for an ambiguous goal", () => {
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  let promptCalls = 0;
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true,
    prompt: async () => { promptCalls += 1; return ""; }, // user presses Enter ⇒ proceed with original goal
  });
  return cli.build(["fix", "it"]).then(() => {
    assert.equal(promptCalls, 1, "the interview prompt fired once for the ambiguous goal");
    assert.equal(cap2.exit, undefined, "pressing Enter proceeds — clean run");
  });
});

test("a non-interactive session skips the interview without --yes (no hang on piped stdin)", () => {
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  let promptCalls = 0;
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: false, // piped / redirected / CI stdin
    prompt: async () => { promptCalls += 1; return ""; },
  });
  return cli.build(["fix", "it"]).then(() => {
    assert.equal(promptCalls, 0, "no blocking prompt when stdin is not a TTY");
    assert.equal(cap2.exit, undefined, "clean run");
  });
});

// ── THE CHAIN PROOF (injected model via capturing roles + real gate-wall) ────

test("build runs the full 5-role pipeline through the orchestrator with the real gate-wall", () => {
  const { orchestrator, resolveIdentity, cap, gateDecision } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo" });

  return cli.build(["fix", "the", "bug", "--repo", "/repo"]).then(() => {
    assert.equal(cap2.exit, undefined, "clean run");
    assert.deepEqual(cap.seen.map((c) => c.role), ["scout", "builder", "verifier", "critic", "integrator"], "all five roles ran");
    for (const c of cap.seen) assert.equal(c.identity.spawnedFrom, "lead", "each role spawned under the dispatching parent");
    assert.equal(gateDecision()?.allow, true, "the REAL gate-wall evaluated the promote (trusted ⇒ allow)");
    const summary = JSON.parse(cap2.out);
    assert.equal(summary.outcome, "success");
    assert.equal(summary.promoted, true);
    assert.equal(summary.roles.length, 5);
  });
});

// ── #10 CLAMP through the command path (credential wiring cannot escalate) ───

test("a worker credential registered ABOVE the parent is clamped to the parent tier (#10)", () => {
  // Parent "verified" (rank 2); worker "trusted" (rank 1 — MORE trusted). Roles must
  // clamp to the PARENT's "verified", never the worker's nominal "trusted".
  const { orchestrator, resolveIdentity, cap } = realOrchestrator("verified", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo" });

  return cli.build(["do", "the", "thing"]).then(() => {
    assert.equal(cap.seen.length, 5);
    for (const c of cap.seen) {
      assert.equal(c.identity.trustTier, "verified", `role ${c.role} clamped to the parent tier, NOT the worker's "trusted"`);
    }
  });
});

// ── gate denial at promote is a CLEAN outcome (not a crash) ──────────────────

test("a gate-denied promote (probation parent) surfaces a discarded/partial outcome, not a crash", () => {
  const { orchestrator, resolveIdentity, gateDecision } = realOrchestrator("probation", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo" });

  return cli.build(["ship", "it"]).then(() => {
    assert.equal(cap2.exit, undefined, "a gate denial is NOT a crash");
    assert.equal(cap2.err, "", "nothing on stderr");
    assert.equal(gateDecision()?.allow, false, "the real gate-wall DENIED the probation promote");
    const summary = JSON.parse(cap2.out);
    assert.equal(summary.promoted, false, "not promoted");
    assert.notEqual(summary.outcome, "success");
  });
});

// ── fail-closed credential checks (no run) ───────────────────────────────────

function countingOrchestrator() {
  const calls: WorkerTask[] = [];
  const orchestrator = {
    run: async (task: WorkerTask): Promise<WorkerResult> => {
      calls.push(task);
      return { contractVersion: "1.0.0", taskId: task.taskId, outcome: "success", roles: [], workspaceId: "w", promoted: true };
    },
  };
  return { orchestrator, calls };
}

test("no operator token ⇒ friendly error, no orchestrator run", () => {
  const oc = countingOrchestrator();
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator: oc.orchestrator, resolveIdentity: makeResolver("trusted", "trusted"), operatorToken: undefined, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1 });
  return cli.build(["x"]).then(() => {
    assert.equal(cap2.exit, 1);
    assert.match(cap2.err, /no operator identity.*IKBI_OPERATOR_TOKEN/);
    assert.equal(oc.calls.length, 0);
  });
});

test("no worker token ⇒ friendly error, no orchestrator run", () => {
  const oc = countingOrchestrator();
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator: oc.orchestrator, resolveIdentity: makeResolver("trusted", "trusted"), operatorToken: OPERATOR_TOKEN, workerToken: undefined, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1 });
  return cli.build(["x"]).then(() => {
    assert.equal(cap2.exit, 1);
    assert.match(cap2.err, /no worker credential.*IKBI_WORKER_TOKEN/);
    assert.equal(oc.calls.length, 0);
  });
});

test("H1: an explicit --repo that does not resolve ⇒ loud error, no run (never silent cwd fallback)", () => {
  const oc = countingOrchestrator();
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator: oc.orchestrator, resolveIdentity: makeResolver("trusted", "trusted"), operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo" });
  // a typo'd alias (non-absolute, not registered) must NOT fall back to cwd
  return cli.build(["fix", "it", "--repo", "zzz-not-a-real-repo-alias"]).then(() => {
    assert.equal(cap2.exit, 1);
    assert.match(cap2.err, /--repo "zzz-not-a-real-repo-alias" did not resolve/);
    assert.equal(oc.calls.length, 0, "no build ran against the wrong directory");
  });
});

test("an empty goal ⇒ usage hint, no run", () => {
  const oc = countingOrchestrator();
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator: oc.orchestrator, resolveIdentity: makeResolver("trusted", "trusted"), operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1 });
  return cli.build([]).then(() => {
    assert.equal(cap2.exit, 1);
    assert.match(cap2.err, /needs a goal/);
    assert.equal(oc.calls.length, 0);
  });
});

// ── FIX: createProductionWorker wires commit (the workspace manager has it) ───

test("createProductionWorker wires the workspace manager (commit) + governedExec into the orchestrator", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const src = await readFile(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf8");
  // createProductionWorker passes workspaces (coreWorkspaces, which provides commit) explicitly.
  assert.match(src, /createOrchestrator\(\{[^}]*workspaces: coreWorkspaces/, "the production worker threads the workspace manager (with commit)");
  assert.match(src, /import \{ workspaces as coreWorkspaces \} from "\.\.\/\.\.\/core\/workspace\/index\.js"/, "imports the workspace manager singleton");
});

test("the workspace manager singleton actually provides a commit method (production path has commit)", async () => {
  const { workspaces } = await import("../../core/workspace/index.js");
  assert.equal(typeof workspaces.commit, "function", "coreWorkspaces.commit exists — the orchestrator can commit verified work");
});

// ── M4: a cognition `reject` is surfaced (not silently discarded) under --yes ──

test("M4: under --yes, a cognition `reject` is warned to STDERR (advisory, build proceeds)", () => {
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  let promptCalls = 0;
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true,
    prompt: async () => { promptCalls += 1; return ""; },
    // Force deliberation to REJECT — the historically-discarded signal.
    cognition: { deliberate: async () => ({ decision: "reject", confidence: 0.9, rationale: "goal conflicts with policy", memoryUsed: [] }) },
  });
  return cli.build(["delete", "everything", "--yes"]).then(() => {
    assert.equal(promptCalls, 0, "--yes never prompts");
    // The rejection is surfaced on STDERR (not stdout — stdout stays machine-readable).
    assert.match(cap2.err, /REJECTED/, "the reject was warned, not silently discarded");
    assert.match(cap2.err, /goal conflicts with policy/, "the rationale is included in the warning");
    assert.equal(cap2.out.includes("REJECTED"), false, "the warning did NOT leak onto stdout");
    // Advisory: the build still ran to a clean outcome.
    const summary = JSON.parse(cap2.out);
    assert.equal(summary.outcome, "success", "--yes proceeds past the advisory reject");
  });
});

test("M4: under --yes, a non-reject cognition decision emits NO reject warning", () => {
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true,
    prompt: async () => "",
    cognition: { deliberate: async () => ({ decision: "answer", confidence: 0.9, rationale: "clear", memoryUsed: [] }) },
  });
  return cli.build(["add a readme", "--yes"]).then(() => {
    assert.equal(cap2.err.includes("REJECTED"), false, "no reject warning when deliberation did not reject");
  });
});
