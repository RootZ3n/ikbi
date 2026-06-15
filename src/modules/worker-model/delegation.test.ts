import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { validateDelegationEnvelope, type DelegationEnvelope, WORKER_ROLES } from "./contract.js";
import { parseBuildArgs, createWorkerCli, productionRoleClaim } from "./cli.js";
import type { WorkerTask, RoleFn, WorkerRole } from "./contract.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, type TrustDecision } from "../../core/trust/index.js";
import { TRUST_FLOOR } from "../../core/trust/index.js";
import { createGateWall } from "../gate-wall/index.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";

const OPERATOR_TOKEN = "op-delegation-test-token";
const WORKER_TOKEN = "worker-delegation-test-token";
const silent = () => pino({ level: "silent" });

// ── validateDelegationEnvelope ────────────────────────────────────────────────

test("delegation: valid envelope with all required fields is accepted", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    repoPath: "/repos/myproject",
    taskType: "build",
    objective: "fix the failing tests",
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, true);
});

test("delegation: valid envelope with optional fields is accepted", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    humanOperator: "zen",
    repoPath: "/repos/myproject",
    targetBranch: "main",
    taskType: "fix",
    objective: "fix the type errors",
    constraints: ["no new dependencies"],
    approvalRequired: true,
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, true);
});

test("delegation: missing repoPath is rejected", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    repoPath: "",
    taskType: "build",
    objective: "fix the failing tests",
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.reason, /repoPath/);
  }
});

test("delegation: whitespace-only repoPath is rejected", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    repoPath: "   ",
    taskType: "build",
    objective: "fix the failing tests",
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.reason, /repoPath/);
  }
});

test("delegation: missing objective is rejected", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    repoPath: "/repos/myproject",
    taskType: "build",
    objective: "",
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.reason, /objective/);
  }
});

test("delegation: whitespace-only objective is rejected", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    repoPath: "/repos/myproject",
    taskType: "audit",
    objective: "  ",
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.reason, /objective/);
  }
});

test("delegation: approvalRequired true without humanOperator is rejected", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    repoPath: "/repos/myproject",
    taskType: "build",
    objective: "fix the failing tests",
    approvalRequired: true,
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.reason, /humanOperator/);
  }
});

test("delegation: approvalRequired false without humanOperator is accepted", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    repoPath: "/repos/myproject",
    taskType: "build",
    objective: "fix the failing tests",
    approvalRequired: false,
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, true);
});

test("delegation: approvalRequired true with empty humanOperator is rejected", () => {
  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    humanOperator: "  ",
    repoPath: "/repos/myproject",
    taskType: "build",
    objective: "fix the failing tests",
    approvalRequired: true,
  };
  const result = validateDelegationEnvelope(env);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.match(result.reason, /humanOperator/);
  }
});

test("delegation: all three valid taskTypes are accepted", () => {
  for (const taskType of ["build", "audit", "fix"] as const) {
    const env: DelegationEnvelope = {
      originAgent: "pehlichi",
      repoPath: "/repos/myproject",
      taskType,
      objective: "do something",
    };
    const result = validateDelegationEnvelope(env);
    assert.equal(result.valid, true, `taskType "${taskType}" should be valid`);
  }
});

// ── parseBuildArgs with --delegation ─────────────────────────────────────────

test("delegation: parseBuildArgs extracts --delegation value", () => {
  const json = JSON.stringify({ originAgent: "pehlichi", repoPath: "/r", taskType: "build", objective: "fix it" });
  const result = parseBuildArgs(["--delegation", json]);
  assert.equal(result.delegation, json);
  assert.deepEqual(result.rest, []);
});

test("delegation: parseBuildArgs extracts --delegation= value", () => {
  const json = '{"originAgent":"p","repoPath":"/r","taskType":"fix","objective":"go"}';
  const result = parseBuildArgs([`--delegation=${json}`]);
  assert.equal(result.delegation, json);
});

test("delegation: parseBuildArgs without --delegation has no delegation field", () => {
  const result = parseBuildArgs(["fix", "the", "bug"]);
  assert.equal("delegation" in result, false);
});

test("delegation: parseBuildArgs --delegation does not conflict with other flags", () => {
  const json = '{"originAgent":"p","repoPath":"/r","taskType":"build","objective":"goal"}';
  const result = parseBuildArgs(["--repo", "/myrepo", "--verbose", "--delegation", json]);
  assert.equal(result.repo, "/myrepo");
  assert.equal(result.verbose, true);
  assert.equal(result.delegation, json);
  assert.deepEqual(result.rest, []);
});

// ── CLI integration helpers ───────────────────────────────────────────────────

const ENABLED = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };

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

const benignCognition = { deliberate: async () => ({ decision: "answer" as const, confidence: 1, rationale: "ok", memoryUsed: [] as string[] }) };

function fakeWorkspaceHandle(targetRepo = "/delegated/repo"): WorkspaceHandle {
  return { id: "ws-deleg", targetRepo, baseBranch: "main", baseRef: "abc123", scratchBranch: "ikbi/ws/ws-deleg", path: "/tmp/ws-deleg", identity: { agentId: "lead" }, state: "allocated", createdAt: 1000 };
}

function capturingRoles(capturedTasks: WorkerTask[]) {
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async (ctx) => {
      capturedTasks.push(ctx.task);
      if (r === "integrator") {
        return { role: r, outcome: "success", summary: r, detail: { decision: "promote", rationale: "test", evaluation: { approved: true } } };
      }
      return { role: r, outcome: "success", summary: r };
    };
  }
  return roles;
}

function makeOrchestrator(capturedTasks: WorkerTask[], targetRepo: string) {
  const handle = fakeWorkspaceHandle(targetRepo);
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h, a): Promise<PromoteResult> =>
      a.governance?.allow
        ? { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }
        : { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", reason: "denied" },
    discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
  };
  const realGateWall = createGateWall({ receipts: fakeReceipts(), publish: () => {} });
  const gateWall = {
    evaluate: async (...args: Parameters<typeof realGateWall.evaluate>): Promise<PromoteGovernance> =>
      realGateWall.evaluate(...args),
  };
  return createOrchestrator({
    config: ENABLED,
    resolveIdentity: makeResolver("trusted", "trusted"),
    roleClaim: productionRoleClaim(WORKER_TOKEN),
    roles: capturingRoles(capturedTasks),
    workspaces,
    gateWall,
    trust: fakeTrust(),
    receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    invokeModel: async () => { throw new Error("invokeModel not used (capturing roles)"); },
  });
}

// ── createWorkerCli with --delegation ────────────────────────────────────────

test("delegation: --delegation sets originAgent on the task", async () => {
  const capturedTasks: WorkerTask[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  let exitCode = 0;

  const env: DelegationEnvelope = {
    originAgent: "pehlichi",
    repoPath: "/delegated/repo",
    taskType: "build",
    objective: "fix the failing tests",
  };
  const delegationJson = JSON.stringify(env);

  const orchestrator = makeOrchestrator(capturedTasks, "/delegated/repo");
  const cli = createWorkerCli({
    orchestrator,
    resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    stdout: (s) => output.push(s),
    stderr: (s) => errors.push(s),
    setExit: (c) => void (exitCode = c),
    now: () => 42000,
    cwd: () => "/cwd",
    interactive: false,
    cognition: benignCognition,
  });

  await cli.build(["--delegation", delegationJson]);

  assert.equal(exitCode, 0, `unexpected exit ${exitCode}, errors: ${errors.join("")}`);
  const first = capturedTasks[0];
  assert.ok(first !== undefined, "at least one task should have been captured");
  assert.equal(first.originAgent, "pehlichi");
  assert.equal(first.targetRepo, "/delegated/repo");
  assert.equal(first.goal, "fix the failing tests");
});

test("delegation: --delegation invalid JSON exits 1", async () => {
  let exitCode = 0;
  const errors: string[] = [];

  const cli = createWorkerCli({
    operatorToken: OPERATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    stdout: () => undefined,
    stderr: (s) => errors.push(s),
    setExit: (c) => void (exitCode = c),
    now: () => 1,
    cwd: () => "/cwd",
    interactive: false,
  });

  await cli.build(["--delegation", "not-valid-json"]);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes("invalid JSON")));
});

test("delegation: --delegation with missing repoPath exits 1", async () => {
  let exitCode = 0;
  const errors: string[] = [];

  const cli = createWorkerCli({
    operatorToken: OPERATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    stdout: () => undefined,
    stderr: (s) => errors.push(s),
    setExit: (c) => void (exitCode = c),
    now: () => 1,
    cwd: () => "/cwd",
    interactive: false,
  });

  const bad = JSON.stringify({ originAgent: "p", repoPath: "", taskType: "build", objective: "fix it" });
  await cli.build(["--delegation", bad]);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes("repoPath")));
});

test("delegation: --delegation with missing objective exits 1", async () => {
  let exitCode = 0;
  const errors: string[] = [];

  const cli = createWorkerCli({
    operatorToken: OPERATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    stdout: () => undefined,
    stderr: (s) => errors.push(s),
    setExit: (c) => void (exitCode = c),
    now: () => 1,
    cwd: () => "/cwd",
    interactive: false,
  });

  const bad = JSON.stringify({ originAgent: "p", repoPath: "/r", taskType: "build", objective: "" });
  await cli.build(["--delegation", bad]);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes("objective")));
});

test("delegation: approvalRequired without humanOperator exits 1", async () => {
  let exitCode = 0;
  const errors: string[] = [];

  const cli = createWorkerCli({
    operatorToken: OPERATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    stdout: () => undefined,
    stderr: (s) => errors.push(s),
    setExit: (c) => void (exitCode = c),
    now: () => 1,
    cwd: () => "/cwd",
    interactive: false,
  });

  const bad = JSON.stringify({ originAgent: "p", repoPath: "/r", taskType: "build", objective: "fix it", approvalRequired: true });
  await cli.build(["--delegation", bad]);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes("humanOperator")));
});

test("delegation: existing build command behavior unchanged without --delegation flag", async () => {
  const capturedTasks: WorkerTask[] = [];
  const output: string[] = [];
  let exitCode = 0;

  const orchestrator = makeOrchestrator(capturedTasks, "/cwd");
  const cli = createWorkerCli({
    orchestrator,
    resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    stdout: (s) => output.push(s),
    stderr: () => undefined,
    setExit: (c) => void (exitCode = c),
    now: () => 99000,
    cwd: () => "/cwd",
    interactive: false,
    cognition: benignCognition,
  });

  await cli.build(["fix the failing tests"]);

  assert.equal(exitCode, 0, "normal build should succeed");
  const first = capturedTasks[0];
  assert.ok(first !== undefined);
  assert.equal(first.originAgent, undefined, "no originAgent without --delegation");
  assert.equal(first.targetRepo, "/cwd");
  assert.equal(first.goal, "fix the failing tests");
});
