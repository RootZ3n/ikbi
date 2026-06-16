/**
 * HERMES → IKBI CONTRACT TESTS (lab-trust sprint, Phase 5).
 *
 * Proves the delegation contract that makes Hermes/Pehlichi → Ikbi repair loops
 * safe for SUPERVISED use: a valid envelope is accepted, an invalid one rejected,
 * read-only audit does not mutate, mutation requires human approval, origin and
 * the full governance trail (taskId/workspaceId/requestId/approval/verification)
 * are preserved in receipts, failure is visible, and a delegation run never
 * installs durable memory/skills behind the operator's back.
 *
 * Callers are FAKE Hermes/Pehlichi (they just hand Ikbi a DelegationEnvelope).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import { validateDelegationEnvelope, type DelegationEnvelope, WORKER_ROLES } from "./contract.js";
import { createWorkerCli, productionRoleClaim } from "./cli.js";
import type { WorkerTask, RoleFn, WorkerRole } from "./contract.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, type TrustDecision } from "../../core/trust/index.js";
import { TRUST_FLOOR } from "../../core/trust/index.js";
import { createGateWall } from "../gate-wall/index.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { runMultiAudit } from "./multi-audit.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";

const OPERATOR_TOKEN = "op-hermes-contract-token";
const WORKER_TOKEN = "worker-hermes-contract-token";
const silent = () => pino({ level: "silent" });
const ENABLED = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };

function makeResolver() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({
      agents: [
        { agentId: "lead", kind: "agent", functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken(OPERATOR_TOKEN)] },
        { agentId: "worker", kind: "agent", functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken(WORKER_TOKEN)] },
      ],
    }),
    logger: silent(),
    now: () => 1000,
  });
  return (claim: { token?: string }) => resolver.resolve(claim);
}

const fakeTrust = () => ({
  recordOutcome: async (i: { agentId: string; defaultTrustTier: string }): Promise<TrustDecision> => {
    const tier = asTier(i.defaultTrustTier, TRUST_FLOOR);
    return { agentId: i.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) };
  },
});

const noopBus = () => ({
  publish: <P>(input: P) => ({ ...(input as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown,
  subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
  flush: async () => {},
});

const benignCognition = { deliberate: async () => ({ decision: "answer" as const, confidence: 1, rationale: "ok", memoryUsed: [] as string[] }) };

function fakeWorkspaceHandle(targetRepo: string): WorkspaceHandle {
  return { id: "ws-hermes", targetRepo, baseBranch: "main", baseRef: "abc123", scratchBranch: "ikbi/ws/ws-hermes", path: "/tmp/ws-hermes", identity: { agentId: "lead" }, state: "allocated", createdAt: 1000 };
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

interface RecordedReceipt {
  operation: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  project?: string;
  outcome: { status: string; detail?: string };
}

function recordingReceipts(sink: RecordedReceipt[]) {
  return {
    append: async (input: unknown, _id: AgentIdentity): Promise<unknown> => {
      sink.push(input as RecordedReceipt);
      return {};
    },
  };
}

interface OrchOpts {
  requestApproval?: (req: { taskId: string; workspaceId: string; goal: string }) => Promise<boolean>;
  receiptsSink?: RecordedReceipt[];
  promoteSink?: { promotedCalled: boolean };
}

function makeOrchestrator(capturedTasks: WorkerTask[], targetRepo: string, opts: OrchOpts = {}) {
  const handle = fakeWorkspaceHandle(targetRepo);
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h, a): Promise<PromoteResult> => {
      if (opts.promoteSink) opts.promoteSink.promotedCalled = true;
      return a.governance?.allow
        ? { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }
        : { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", reason: "denied" };
    },
    discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
  };
  const realGateWall = createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} });
  const gateWall = {
    evaluate: async (...args: Parameters<typeof realGateWall.evaluate>): Promise<PromoteGovernance> => realGateWall.evaluate(...args),
  };
  return createOrchestrator({
    config: ENABLED,
    resolveIdentity: makeResolver(),
    roleClaim: productionRoleClaim(WORKER_TOKEN),
    roles: capturingRoles(capturedTasks),
    workspaces,
    gateWall,
    trust: fakeTrust(),
    receipts: recordingReceipts(opts.receiptsSink ?? []),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    invokeModel: async () => { throw new Error("invokeModel not used (capturing roles)"); },
    ...(opts.requestApproval !== undefined ? { requestApproval: opts.requestApproval } : {}),
  });
}

function makeCli(orchestrator: ReturnType<typeof makeOrchestrator>, io: { output: string[]; errors: string[]; setExit: (c: number) => void }) {
  return createWorkerCli({
    orchestrator,
    resolveIdentity: makeResolver(),
    operatorToken: OPERATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    stdout: (s) => io.output.push(s),
    stderr: (s) => io.errors.push(s),
    setExit: io.setExit,
    now: () => 42000,
    cwd: () => "/cwd",
    interactive: false,
    cognition: benignCognition,
  });
}

function runSummaryOf(sink: RecordedReceipt[]): RecordedReceipt | undefined {
  return sink.find((r) => r.operation === "worker.run.summary");
}

// ── 1 & 2: envelope acceptance / rejection ───────────────────────────────────

test("contract: a valid Hermes DelegationEnvelope is accepted", () => {
  const env: DelegationEnvelope = {
    originAgent: "hermes",
    humanOperator: "zen",
    repoPath: "/delegated/repo",
    taskType: "fix",
    objective: "repair the failing build",
    approvalRequired: true,
  };
  assert.equal(validateDelegationEnvelope(env).valid, true);
});

test("contract: an invalid Hermes DelegationEnvelope is rejected (mutation approvalRequired without operator)", () => {
  const env: DelegationEnvelope = {
    originAgent: "hermes",
    repoPath: "/delegated/repo",
    taskType: "fix",
    objective: "repair the failing build",
    approvalRequired: true, // but no humanOperator
  };
  const res = validateDelegationEnvelope(env);
  assert.equal(res.valid, false);
  if (!res.valid) assert.match(res.reason, /humanOperator/);
});

// ── 3: read-only audit delegation does not mutate the repo ───────────────────

test("contract: a read-only audit (multi-audit) never writes to the delegated repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "hermes-audit-"));
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  const before = readdirSync(repo).sort();
  const beforeContent = readFileSync(join(repo, "a.ts"), "utf8");

  const invokeModel = async (_req: ModelRequest): Promise<ModelResponse> => ({
    contractVersion: "1.1.0", model: "m", provider: "t", providerModelId: "m",
    content: "- a.ts:1 — exported const could be validated",
    finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0.001, promptUsd: 0, cachedUsd: 0, completionUsd: 0.001, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  });

  const result = await runMultiAudit({ repoPath: repo, models: ["m"], invokeModel });
  assert.ok(result.models.length === 1);
  // Repo is byte-for-byte unchanged — audit is read-only.
  assert.deepEqual(readdirSync(repo).sort(), before);
  assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), beforeContent);
});

// ── 4 & 5: mutation delegation requires human approval ───────────────────────

test("contract: mutation delegation WITHOUT approval does not promote and the failure is visible", async () => {
  const capturedTasks: WorkerTask[] = [];
  const sink: RecordedReceipt[] = [];
  const promoteSink = { promotedCalled: false };
  const io = { output: [] as string[], errors: [] as string[], setExit: (_c: number) => {} };

  // Fake Hermes operator DENIES the promotion at the approval gate.
  const orchestrator = makeOrchestrator(capturedTasks, "/delegated/repo", {
    requestApproval: async () => false,
    receiptsSink: sink,
    promoteSink,
  });
  const env: DelegationEnvelope = {
    originAgent: "hermes", humanOperator: "zen", repoPath: "/delegated/repo",
    taskType: "fix", objective: "repair the build", approvalRequired: true,
  };
  await makeCli(orchestrator, io).build(["--delegation", JSON.stringify(env)]);

  assert.equal(promoteSink.promotedCalled, false, "no promote without approval");
  const summary = runSummaryOf(sink);
  assert.ok(summary !== undefined, "a run summary receipt was written");
  assert.equal(summary!.metadata?.promoted, false);
  // Failure visible to the operator (receipt detail + CLI output).
  assert.match(String(summary!.outcome.detail ?? ""), /approval gate/i);
});

test("contract: mutation delegation WITH approval promotes and preserves the full governance trail", async () => {
  const capturedTasks: WorkerTask[] = [];
  const sink: RecordedReceipt[] = [];
  const promoteSink = { promotedCalled: false };
  const io = { output: [] as string[], errors: [] as string[], setExit: (_c: number) => {} };

  const approvals: { taskId: string; workspaceId: string }[] = [];
  const orchestrator = makeOrchestrator(capturedTasks, "/delegated/repo", {
    requestApproval: async (req) => { approvals.push({ taskId: req.taskId, workspaceId: req.workspaceId }); return true; },
    receiptsSink: sink,
    promoteSink,
  });
  const env: DelegationEnvelope = {
    originAgent: "hermes", humanOperator: "zen", repoPath: "/delegated/repo",
    taskType: "fix", objective: "repair the build", approvalRequired: true,
  };
  await makeCli(orchestrator, io).build(["--delegation", JSON.stringify(env)]);

  assert.equal(promoteSink.promotedCalled, true, "promote happened after approval");
  assert.equal(approvals.length, 1, "the human approval gate was consulted");

  const summary = runSummaryOf(sink);
  assert.ok(summary !== undefined);
  const meta = summary!.metadata!;
  assert.equal(meta.originAgent, "hermes", "origin agent preserved in the receipt");
  assert.equal(meta.promoted, true, "promotion result recorded");
  assert.ok(typeof meta.taskId === "string" && (meta.taskId as string).length > 0, "taskId preserved");
  assert.ok(typeof meta.workspaceId === "string" && (meta.workspaceId as string).length > 0, "workspaceId preserved");
  assert.equal(summary!.requestId, meta.taskId, "requestId ties the trail together");
  assert.equal(meta.targetRepo, "/delegated/repo", "repo/project preserved");
  assert.ok("verificationResult" in meta, "verification result recorded");
  // The approval gate saw the SAME task/workspace that landed.
  assert.equal(approvals[0]!.taskId, meta.taskId);
  assert.equal(approvals[0]!.workspaceId, meta.workspaceId);
});

// ── 8: a delegation run never installs durable memory/skills/rules ───────────

test("contract: a Hermes delegation run records NO memory/skill/rule install operations", async () => {
  const capturedTasks: WorkerTask[] = [];
  const sink: RecordedReceipt[] = [];
  const io = { output: [] as string[], errors: [] as string[], setExit: (_c: number) => {} };
  const orchestrator = makeOrchestrator(capturedTasks, "/delegated/repo", {
    requestApproval: async () => true,
    receiptsSink: sink,
  });
  const env: DelegationEnvelope = {
    originAgent: "hermes", humanOperator: "zen", repoPath: "/delegated/repo",
    taskType: "fix", objective: "repair the build", approvalRequired: true,
  };
  await makeCli(orchestrator, io).build(["--delegation", JSON.stringify(env)]);

  assert.ok(sink.length > 0, "the run produced receipts");
  const installs = sink.filter((r) => /(?:memory|skill|rule)[.:_-]?install/i.test(r.operation));
  assert.equal(installs.length, 0, "a repair loop must not install durable memory/skills/rules");
  // Every receipt is a worker/workspace operation — origin is auditable on the run summary.
  assert.equal(runSummaryOf(sink)!.metadata?.originAgent, "hermes");
});

// ── 9: origin visible across role receipts too ───────────────────────────────

test("contract: the delegated task carries originAgent into the orchestrator (visible to receipts)", async () => {
  const capturedTasks: WorkerTask[] = [];
  const io = { output: [] as string[], errors: [] as string[], setExit: (_c: number) => {} };
  const orchestrator = makeOrchestrator(capturedTasks, "/delegated/repo", { requestApproval: async () => true });
  const env: DelegationEnvelope = {
    originAgent: "pehlichi", humanOperator: "zen", repoPath: "/delegated/repo",
    taskType: "build", objective: "build the thing", approvalRequired: true,
  };
  await makeCli(orchestrator, io).build(["--delegation", JSON.stringify(env)]);
  assert.ok(capturedTasks.length > 0);
  assert.equal(capturedTasks[0]!.originAgent, "pehlichi");
});
