/**
 * Day-5 acceptance harness (NOT a test file) — shared real-path wiring.
 *
 * Builds a production-shaped worker orchestrator against REAL collaborators: a real
 * WorkspaceManager (real git worktrees), the real governed-exec executor, the real
 * gate-wall, and the REAL verifier (the deterministic, model-free role). Only the
 * model-driven roles (scout / builder / critic / integrator) are stubbed, since these
 * tests run without a model — exactly how the orchestrator is integration-tested.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pino, type Logger } from "pino";

import { beginOperation, IdentityResolver } from "../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../core/identity/registry.js";
import type { OperationContext } from "../core/identity/resolver.js";
import { LockManager } from "../core/substrate/lock.js";
import { DocumentStore } from "../core/substrate/store.js";
import type { WorkspaceRecord } from "../core/workspace/contract.js";
import { runGit } from "../core/workspace/git.js";
import { WorkspaceManager } from "../core/workspace/manager.js";
import { createGateWall } from "../modules/gate-wall/index.js";
import { createGovernedExec, type GovernedExec } from "../modules/governed-exec/index.js";
import { createOrchestrator, type OrchestratorDeps } from "../modules/worker-model/orchestrator.js";
import { productionRoleClaim } from "../modules/worker-model/cli.js";
import { WORKER_ROLES, type RoleFn, type WorkerRole, type WorkerResult, type WorkerTask } from "../modules/worker-model/contract.js";

export const silent = (): Logger => pino({ level: "silent" });
export const OPERATOR_TOKEN = "operator-token-value";
export const WORKER_TOKEN = "worker-token-value";

/** A REAL identity resolver over operator(lead) + worker agents, with a parent operation ctx. */
export function makeIdentities(operatorTier = "operator", workerTier = "trusted") {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({
      agents: [
        { agentId: "lead", kind: "operator", functionalRole: "lead", defaultTrustTier: operatorTier, tokenHashes: [hashToken(OPERATOR_TOKEN)] },
        { agentId: "worker", kind: "agent", functionalRole: "worker", defaultTrustTier: workerTier, tokenHashes: [hashToken(WORKER_TOKEN)] },
      ],
    }),
    logger: silent(),
    now: () => 1000,
  });
  const parentCtx: OperationContext = beginOperation(resolver.resolve({ token: OPERATOR_TOKEN }), { requestId: `accept-${randomBytes(4).toString("hex")}` });
  return {
    parentCtx,
    resolveIdentity: ((claim: { token?: string }, ctx?: unknown) => resolver.resolve(claim, ctx as never)) as NonNullable<OrchestratorDeps["resolveIdentity"]>,
    roleClaim: productionRoleClaim(WORKER_TOKEN),
  };
}

/** Create a REAL git repo. With `packageJson`, writes one (so the project-root guard passes). */
export async function makeGitRepo(opts: { packageJson?: Record<string, unknown>; claudeMd?: string } = {}): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-accept-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi accept"]);
  await writeFile(join(repo, "README.md"), "base\n");
  if (opts.packageJson !== undefined) await writeFile(join(repo, "package.json"), JSON.stringify(opts.packageJson, null, 2));
  if (opts.claudeMd !== undefined) await writeFile(join(repo, "CLAUDE.md"), opts.claudeMd);
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}

/** A real WorkspaceManager over a fresh temp root. */
export function makeManager() {
  const root = join(tmpdir(), `ikbi-accept-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent(), defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent(), fsync: false });
  const manager = new WorkspaceManager({ root, max: 16, locks, store, logger: silent() });
  return { manager, root };
}

/** A REAL governed executor with a test allowlist (the real governance logic; config is test-set). */
export function realGovernedExec(allowlist: readonly string[]): GovernedExec {
  return createGovernedExec({
    config: { enabled: true, allowlist: [...allowlist], execTimeoutMs: 30_000, maxBuffer: 8_000_000, networkTimeoutMs: 5_000 },
    gateWall: createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} }),
    receipts: { append: async () => ({}) },
    publish: () => {},
  });
}

/** Stub model-driven roles: scout/critic succeed; builder writes (+commits) a file; integrator promotes. */
export function stubRoles(opts: { write?: { path: string; content: string } } = {}): Partial<Record<WorkerRole, RoleFn>> {
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    if (r === "verifier") continue; // the REAL verifier runs
    roles[r] = async (ctx) => {
      if (r === "builder" && opts.write !== undefined) {
        await writeFile(join(ctx.workspace.path, opts.write.path), opts.write.content);
        // Commit in the worktree so the scratch branch advances (promote sees a real diff)
        // regardless of the orchestrator's tier-gated auto-commit.
        await runGit(ctx.workspace.path, ["add", "-A"]);
        await runGit(ctx.workspace.path, ["commit", "--quiet", "-m", "stub builder change"]);
        return { role: r, outcome: "success", summary: r, detail: { toolRounds: 1, filesWritten: [opts.write.path], rejectedToolCalls: [], stopReason: "stop" } };
      }
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", rationale: "accept", evaluation: { approved: true } } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return roles;
}

/** Build a production-shaped orchestrator over real collaborators (verifier real; model-roles stubbed). */
export function realOrchestrator(args: {
  targetRepo: string;
  manager: WorkspaceManager;
  governedExec: GovernedExec;
  resolveIdentity: NonNullable<OrchestratorDeps["resolveIdentity"]>;
  roleClaim: NonNullable<OrchestratorDeps["roleClaim"]>;
  roles: Partial<Record<WorkerRole, RoleFn>>;
  events?: OrchestratorDeps["events"];
}): { run: (task: WorkerTask, ctx: OperationContext) => Promise<WorkerResult> } {
  return createOrchestrator({
    config: { enabled: true, roleTimeoutMs: 60_000, maxConcurrentRuns: 1 },
    resolveIdentity: args.resolveIdentity,
    roleClaim: args.roleClaim,
    roles: args.roles,
    workspaces: args.manager,
    governedExec: args.governedExec,
    gateWall: createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} }),
    enforceProjectRoot: true, // the production project-root guard (HB-1)
    trust: { recordOutcome: async (i: { agentId: string; defaultTrustTier: string }) => { const { asTier, autonomyForTier, TRUST_FLOOR } = await import("../core/trust/index.js"); const t = asTier(i.defaultTrustTier, TRUST_FLOOR); return { agentId: i.agentId, tier: t, previousTier: t, autonomy: autonomyForTier(t) }; } },
    receipts: { append: async () => ({}) },
    killCheck: async () => ({ killed: false }),
    invokeModel: async () => { throw new Error("model not used (stubbed roles)"); },
    ...(args.events !== undefined ? { events: args.events } : {}),
  });
}

export async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
}
