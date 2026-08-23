import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, TRUST_FLOOR, type TrustDecision } from "../../core/trust/index.js";
import type { DiscardResult, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { WORKER_ROLES, type RoleContext, type RoleFn, type WorkerRole, type WorkerTask } from "./contract.js";
import { LARGE_COMPLEXITY_TIMEOUT_FACTOR, resolveBuilderTimeoutMs, resolveTotalBudgetMs } from "./config.js";
import { effectiveMaxIterations, MAX_TOOL_ITERATIONS } from "./builder.js";

// ── Pure resolver logic: the --complexity-large wall-clock bump ───────────────────────────────────

test("resolveBuilderTimeoutMs: large scales by the factor; other complexities pass through", () => {
  const base = 300_000;
  assert.equal(resolveBuilderTimeoutMs(base, "large"), base * LARGE_COMPLEXITY_TIMEOUT_FACTOR);
  assert.equal(resolveBuilderTimeoutMs(base, "medium"), base, "medium is unchanged");
  assert.equal(resolveBuilderTimeoutMs(base, "small"), base, "small is unchanged");
  assert.equal(resolveBuilderTimeoutMs(base, undefined), base, "no complexity ⇒ base (default build unchanged)");
});

test("resolveBuilderTimeoutMs: a disabled per-role guard (base ≤ 0) stays disabled even for large", () => {
  assert.equal(resolveBuilderTimeoutMs(0, "large"), 0, "scaling zero is meaningless — stays disabled");
  assert.equal(resolveBuilderTimeoutMs(-1, "large"), -1, "a negative (disabled) sentinel is preserved");
});

test("resolveTotalBudgetMs: large scales the whole-pipeline ceiling so the scaled builder fits", () => {
  const base = 1_800_000;
  assert.equal(resolveTotalBudgetMs(base, "large"), base * LARGE_COMPLEXITY_TIMEOUT_FACTOR);
  assert.equal(resolveTotalBudgetMs(base, "medium"), base);
  assert.equal(resolveTotalBudgetMs(base, undefined), base);
  assert.equal(resolveTotalBudgetMs(0, "large"), 0, "a disabled budget stays disabled");
});

test("effectiveMaxIterations: large scales the round cap by the same factor; others pass through", () => {
  assert.equal(effectiveMaxIterations("large"), MAX_TOOL_ITERATIONS * LARGE_COMPLEXITY_TIMEOUT_FACTOR);
  assert.equal(effectiveMaxIterations("medium"), MAX_TOOL_ITERATIONS);
  assert.equal(effectiveMaxIterations("small"), MAX_TOOL_ITERATIONS);
  assert.equal(effectiveMaxIterations(undefined), MAX_TOOL_ITERATIONS, "default build's round cap unchanged");
});

// ── Wiring: a large build's builder is NOT cut off at the base per-role timeout ────────────────────

const silent = () => pino({ level: "silent" });

function makeIdentities() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({
      agents: [
        { agentId: "parent-1", kind: "agent", functionalRole: "lead", defaultTrustTier: "trusted", tokenHashes: [hashToken("parent-secret")] },
        { agentId: "worker-1", kind: "agent", functionalRole: "worker", defaultTrustTier: "trusted", tokenHashes: [hashToken("worker-secret")] },
      ],
    }),
    logger: silent(),
    now: () => 1000,
  });
  const parentCtx = beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
  const resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]> = (claim, ctx) => resolver.resolve(claim, ctx);
  const roleClaim: NonNullable<OrchestratorDeps["roleClaim"]> = () => ({ token: "worker-secret" });
  return { parentCtx, resolveIdentity, roleClaim };
}

/** Roles that succeed instantly, EXCEPT the builder, which resolves after `builderDelayMs` — long
 *  enough to blow the base per-role timeout but shorter than the --complexity-large scaled budget. */
function delayedBuilderRoles(builderDelayMs: number) {
  const seen: WorkerRole[] = [];
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async (_ctx: RoleContext) => {
      seen.push(r);
      if (r === "builder") await new Promise((res) => setTimeout(res, builderDelayMs));
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", evaluation: { approved: true } } };
      if (r === "verifier") return { role: r, outcome: "success", summary: r, detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }] } };
      // A GREEN critic states its PASS verdict (`detail.pass`) — the field the authoritative core reads.
      if (r === "critic") return { role: r, outcome: "success", summary: r, detail: { pass: true } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { seen, roles };
}

function fakeWorkspaces() {
  const handle: WorkspaceHandle = { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/lab-fake/wsabcd", identity: { agentId: "parent-1" }, state: "allocated", createdAt: 1000 };
  const calls = { promote: 0 };
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h): Promise<PromoteResult> => { calls.promote += 1; return { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }; },
    discard: async (h): Promise<DiscardResult> => ({ workspaceId: h.id, removed: true }),
  };
  return { workspaces, calls };
}

const fakeTrust = () => ({ recordOutcome: async (i: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => { const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } });
const fakeReceipts = () => ({ append: async (_i: unknown, _id: AgentIdentity): Promise<unknown> => ({}) });
const noopBus = () => ({ publish: <P>(i: P) => ({ ...(i as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown, subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }), flush: async () => {} });
const allowGate: NonNullable<OrchestratorDeps["gateWall"]> = { evaluate: async () => ({ allow: true, reason: "test gate allows" }) };

function promotableWorkProduct(treeHash = "test-tree-green"): NonNullable<OrchestratorDeps["computeWorkProduct"]> {
  return async () => ({ treeHash, diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, nonEmpty: true });
}

test("wiring: a --complexity large build whose builder runs past the BASE role timeout still promotes", async () => {
  const ids = makeIdentities();
  const ws = fakeWorkspaces();
  // Base per-role timeout 60ms; scaled (×factor) ≥ 180ms. Builder takes 140ms — it would be KILLED at
  // the base 60ms timeout, but survives under the large-scaled budget. If the scaling regressed, the
  // builder role would time out and the run would NOT promote — so this test pins the wiring.
  const roles = delayedBuilderRoles(140);
  const orch = createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 60, maxConcurrentRuns: 1, totalBudgetMs: 600_000 },
    resolveIdentity: ids.resolveIdentity, roleClaim: ids.roleClaim, roles: roles.roles,
    workspaces: ws.workspaces, trust: fakeTrust(), receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    gateWall: allowGate, invokeModel: async () => { throw new Error("unused"); },
    killCheck: async () => ({ killed: false }),
    computeWorkProduct: promotableWorkProduct(),
  });

  const task: WorkerTask = { taskId: "t-large", targetRepo: "/repo", goal: "scaffold a large project", complexity: "large" };
  const r = await orch.run(task, ids.parentCtx);

  assert.ok(roles.seen.includes("builder"), "the builder role ran");
  assert.equal(r.outcome, "success", "the large build was not cut off at the base role timeout");
  assert.equal(r.promoted, true);
  assert.equal(ws.calls.promote, 1);
});
