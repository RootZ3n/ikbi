/**
 * ikbi chat — MANAGED WORKSPACE integration for REPL repo-mode sessions (Phase 2).
 *
 * A repo-mode REPL session no longer edits the operator's repo live-direct. Instead it allocates an
 * isolated git worktree off the repo (the SAME frozen-core `workspaces` primitive `ikbi build` uses)
 * and edits there; `/apply` commits + promotes that worktree into the target repo through the
 * governed, receipt-backed promote, and `/discard` tears the worktree down with the target untouched.
 *
 * This module owns ONLY the glue: resolving the target repo, allocating/reconnecting a workspace, and
 * wrapping a `WorkspaceHandle` as the `SessionWorkspace` the session edits inside. It contains NO git
 * logic of its own — every mutation goes through the workspace manager. The manager is injectable
 * (default: the process-wide singleton) so tests drive a manager with a temp root.
 */

import { execFileSync } from "node:child_process";

import type { OperationContext } from "../../core/identity/index.js";
import type { AgentIdentity } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/contract.js";
import { asTier, TRUST_FLOOR } from "../../core/trust/index.js";
import {
  workspaces,
  type DiscardResult,
  type PromoteResult,
  type WorkspaceHandle,
  type WorkspaceRecord,
} from "../../core/workspace/index.js";
import { gateWall as coreGateWall, type GateWall } from "../gate-wall/index.js";
import { resolveChecks } from "../worker-model/checks.js";
import type { RoleContext, RoleFn, RoleResult, WorkerTask } from "../worker-model/contract.js";
import { resolveVerificationMode } from "../worker-model/modes.js";
import { createVerifier } from "../worker-model/verifier.js";
import type { ApplyVerification, SessionWorkspace } from "./session.js";

/** The subset of the workspace manager the REPL lifecycle needs (the singleton satisfies it). */
export interface WorkspaceManagerLike {
  allocate(opts: { targetRepo: string; identity: AgentIdentity; baseBranch?: string; label?: string }): Promise<WorkspaceHandle>;
  commit(handle: WorkspaceHandle, message: string): Promise<boolean>;
  diff(handle: WorkspaceHandle): Promise<string>;
  promote(handle: WorkspaceHandle, approval: { evaluation: { approved: boolean; evaluatorId?: string; reason?: string }; governance?: { allow: boolean; gateId?: string; reason?: string }; message?: string }): Promise<PromoteResult>;
  discard(handle: WorkspaceHandle): Promise<DiscardResult>;
  get(id: string): Promise<WorkspaceRecord | undefined>;
}

/** The chat session's allocating identity (attribution on every workspace op). */
function chatIdentity(sessionId: string): AgentIdentity {
  return { agentId: "ikbi-chat", functionalRole: "assistant", trustTier: "trusted", sessionId };
}

/**
 * Build the minimal `RoleContext` the verifier reads (it uses only `workspace` + `priorResults`;
 * it never invokes a model). Mirrors the construction the worker-model verifier tests use.
 */
function buildVerifierContext(handle: WorkspaceHandle, sessionId: string): RoleContext {
  return {
    task: { taskId: `repl-apply-${handle.id}`, targetRepo: handle.targetRepo, goal: "repl /apply verification" },
    role: "verifier",
    identity: { agentId: "ikbi-chat", functionalRole: "verifier", trustTier: "trusted", sessionId },
    workspace: handle,
    priorResults: [],
    engine: {
      invokeModel: async () => {
        throw new Error("verifier never invokes a model");
      },
      neutralizeUntrusted: ((c: string) => c) as never,
    },
  } as unknown as RoleContext;
}

/** Map the verifier's `RoleResult` into the `ApplyVerification` `/apply` gates on + displays. */
function mapVerifierResult(r: RoleResult, requestedMode: string): ApplyVerification {
  const d = (r.detail ?? {}) as {
    verdict?: string;
    verificationMode?: string;
    verificationScope?: string;
    checks?: ReadonlyArray<{ name: string; exitCode: number }>;
    triage?: ReadonlyArray<{ stage: string; name: string; passed: boolean; errorSummary: string }>;
    blocked?: boolean;
    blockReasons?: readonly string[];
    failedAt?: { stage: string; task: string };
    receipts?: readonly string[];
    reason?: string;
    qualityIssues?: ReadonlyArray<{ kind: string; detail: string }>;
  };
  const mode = d.verificationMode ?? requestedMode;
  const checks = (d.checks ?? []).map((c) => ({ name: c.name, ok: c.exitCode === 0 }));
  const blocked = d.blocked === true;
  const ok = r.outcome === "success" && d.verdict === "pass";
  let triageSummary: string | undefined;
  if (!ok) {
    const failedTriage = (d.triage ?? []).filter((t) => !t.passed);
    if (failedTriage.length > 0) triageSummary = failedTriage.map((t) => `${t.stage}/${t.name}: ${t.errorSummary}`).join("; ");
    else if (d.qualityIssues !== undefined && d.qualityIssues.length > 0) triageSummary = `quality: ${d.qualityIssues.map((q) => q.kind).join(", ")}`;
    else triageSummary = d.reason ?? r.summary;
  }
  const outcome: ApplyVerification["outcome"] = r.outcome === "success" ? "success" : r.outcome === "stub" ? "stub" : "failure";
  return {
    ran: true,
    ok,
    blocked,
    outcome,
    mode,
    ...(d.verificationScope !== undefined ? { scope: d.verificationScope } : {}),
    checks,
    ...(d.failedAt !== undefined ? { failedAt: d.failedAt } : {}),
    ...(blocked && d.blockReasons !== undefined ? { blockReasons: d.blockReasons } : {}),
    ...(triageSummary !== undefined ? { triageSummary } : {}),
    summary: r.summary ?? (ok ? "verification passed" : "verification failed"),
    receipts: d.receipts ?? [],
  };
}

/** Wrap a live `WorkspaceHandle` as the `SessionWorkspace` a managed chat session edits inside. */
class ManagedWorkspace implements SessionWorkspace {
  constructor(
    private readonly handle: WorkspaceHandle,
    private readonly mgr: WorkspaceManagerLike,
    private readonly sessionId: string,
    /** Injectable verifier (tests). Default: the production-equivalent ladder verifier. */
    private readonly verifierOverride?: RoleFn,
    /** Injectable gate-wall (tests). Default: the live, fail-closed gate-wall the build path uses. */
    private readonly gateWall: GateWall = coreGateWall,
  ) {}

  get id(): string {
    return this.handle.id;
  }
  get path(): string {
    return this.handle.path;
  }
  get targetRepo(): string {
    return this.handle.targetRepo;
  }
  get baseBranch(): string {
    return this.handle.baseBranch;
  }
  get baseRef(): string {
    return this.handle.baseRef;
  }

  diff(): Promise<string> {
    return this.mgr.diff(this.handle);
  }
  commit(message: string): Promise<boolean> {
    return this.mgr.commit(this.handle, message);
  }
  async promote(message: string): Promise<PromoteResult> {
    // GOVERNED promote (Codex blocker 3): the operator explicitly typed `/apply` (operator
    // intent + evaluation), but the promotion ROUTES THROUGH THE SAME gate-wall decision path
    // production build uses — no alternate UI path is weaker than build. The gate produces a
    // durable decision receipt (allow OR deny); a DENY blocks the promote (nothing lands).
    const identity = chatIdentity(this.sessionId);
    const grant = autonomyForTier(asTier(identity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
    const task: WorkerTask = { taskId: `repl-apply-${this.handle.id}`, targetRepo: this.handle.targetRepo, goal: message };
    const governance = await this.gateWall.evaluate({ grant, action: { kind: "promote", task, results: [] }, identity });
    if (!governance.allow) {
      // Fail-closed: the gate-wall denied. It already recorded the deny decision receipt; do not
      // promote (the workspace manager would also refuse a non-allow governance).
      return {
        promoted: false,
        workspaceId: this.handle.id,
        targetBranch: this.handle.baseBranch,
        beforeRef: this.handle.baseRef,
        strategy: "noop",
        reason: `gate-wall denied promotion: ${governance.reason ?? "no reason given"}`,
      };
    }
    return this.mgr.promote(this.handle, {
      // The operator typed `/apply` → evaluation approved; governance is the REAL gate verdict.
      evaluation: { approved: true, evaluatorId: "repl-operator", reason: "operator invoked /apply" },
      governance,
      message,
    });
  }
  discard(): Promise<DiscardResult> {
    return this.mgr.discard(this.handle);
  }

  /**
   * Run ladder verification against the workspace's pending working-tree changes — the SAME verifier
   * `ikbi build` uses (governed checks, script-integrity guard, impact/scope planning, triage). The
   * production wiring: ladder mode by default, the project-root–guarded check set, the run's parent
   * ctx for governed-exec, and the manager's diff as both the integrity + planning source. Fails
   * closed (req 9) when there is no operator context to authorize governed checks.
   */
  async verify(opts: { parentCtx?: OperationContext; env?: NodeJS.ProcessEnv }): Promise<ApplyVerification> {
    const env = opts.env ?? process.env;
    const requestedMode = resolveVerificationMode(env, { production: true });
    if (this.verifierOverride === undefined && opts.parentCtx === undefined) {
      return {
        ran: false, ok: false, blocked: true, outcome: "unavailable", mode: requestedMode, checks: [],
        summary: "verification unavailable: no operator/worker identity to authorize governed checks (set IKBI_OPERATOR_TOKEN / IKBI_WORKER_TOKEN). Failing closed — not promoting.",
        receipts: [],
      };
    }
    const verifierFn =
      this.verifierOverride ??
      createVerifier({
        ...(opts.parentCtx !== undefined ? { parentCtx: opts.parentCtx } : {}),
        diff: (ws) => this.mgr.diff(ws),
        planningDiff: (ws) => this.mgr.diff(ws),
        resolveChecks: (ws) => resolveChecks(ws, env),
        mode: requestedMode,
        env,
      });
    let result: RoleResult;
    try {
      result = await verifierFn(buildVerifierContext(this.handle, this.sessionId));
    } catch (e) {
      return {
        ran: false, ok: false, blocked: true, outcome: "unavailable", mode: requestedMode, checks: [],
        summary: `verification could not run: ${e instanceof Error ? e.message : String(e)}`, receipts: [],
      };
    }
    return mapVerifierResult(result, requestedMode);
  }
}

/**
 * The git toplevel of `cwd` if it is inside a work tree, else undefined. This is the TARGET repo a
 * managed session promotes into (a subdirectory resolves to the repo root, as `ikbi build` expects).
 */
export function resolveRepoTarget(cwd: string): string | undefined {
  try {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return top.length > 0 ? top : undefined;
  } catch {
    return undefined;
  }
}

/** Allocate a managed workspace off `targetRepo` and return it as a `SessionWorkspace`. */
export async function allocateSessionWorkspace(opts: { targetRepo: string; sessionId: string; label?: string; manager?: WorkspaceManagerLike; verifier?: RoleFn; gateWall?: GateWall }): Promise<SessionWorkspace> {
  const mgr = opts.manager ?? workspaces;
  const handle = await mgr.allocate({
    targetRepo: opts.targetRepo,
    identity: chatIdentity(opts.sessionId),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
  });
  return new ManagedWorkspace(handle, mgr, opts.sessionId, opts.verifier, opts.gateWall ?? coreGateWall);
}

/**
 * Reconnect to a previously-allocated workspace by id (for `--resume`/`--continue`). Returns
 * undefined when the workspace is gone or no longer in an editable `allocated` state (promoted /
 * discarded / failed) — the caller then discloses that the managed lifecycle is unavailable.
 */
export async function reconnectSessionWorkspace(workspaceId: string, opts: { manager?: WorkspaceManagerLike; sessionId?: string; verifier?: RoleFn; gateWall?: GateWall } = {}): Promise<SessionWorkspace | undefined> {
  const mgr = opts.manager ?? workspaces;
  const rec = await mgr.get(workspaceId);
  if (rec === undefined || rec.state !== "allocated") return undefined;
  return new ManagedWorkspace(rec, mgr, opts.sessionId ?? workspaceId, opts.verifier, opts.gateWall ?? coreGateWall);
}
