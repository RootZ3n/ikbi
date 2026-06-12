/**
 * ikbi worker-model substrate — THE MODULE CONTRACT (versioned).
 *
 * The worker-model is ONE module (decision #7): a single orchestrator + this
 * contract, with five ROLES as internal collaborators in their own files. It is
 * the hub the gate-wall, subagent-spawning, monitoring, drift and cognition
 * modules sit downstream of. This file is the typed surface they (and the role
 * files) build against; it is versioned like a frozen contract, but lives in the
 * module (it is NOT part of the frozen core registry).
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial worker-model contract: WorkerTask / WorkerResult / WorkerRole
 *           (the five-role enum) / RoleContext + RoleEngine (the role-dispatch
 *           contract) / the orchestrator entry shape. Identity propagation (#10)
 *           and the mandatory neutralize seam (#8) are encoded in the types, not
 *           left to convention.
 *
 * ── ROLE DEFINITIONS (scoped at build, PENDING 3-EYES RULING — not settled) ──
 *   scout      — read-only investigation: gather repo/context, produce findings.
 *                NO writes.
 *   builder    — runs the model + tool loop, produces changes in the workspace.
 *                MUST route MCP tool results through `neutralizeUntrusted`
 *                (source "mcp_result") BEFORE they enter the model loop (#8). The
 *                seam is on `RoleEngine` so the implementation cannot bypass it.
 *   critic     — reviews builder output against task intent: pass/fail + feedback.
 *   verifier   — runs objective checks (tests/typecheck) against the workspace:
 *                a verdict.
 *   integrator — produces the promote DECISION on success / discard on failure.
 *                NOTE: the WORKSPACE LIFECYCLE (allocate/promote/discard) is
 *                executed by the ORCHESTRATOR (freeze-critical), not the role; the
 *                integrator role (next pass) supplies the decision the orchestrator
 *                enacts. Flagged for 3-eyes scrutiny.
 *
 * IDENTITY / ANTI-ESCALATION (#10): the orchestrator entry takes an
 * `OperationContext` carrying the parent `ValidatedIdentity`. Each role is spawned
 * with an identity derived under the PARENT'S TRUST CEILING — a role can NEVER run
 * at a tier above its parent. This is enforced in the orchestrator spawn path (a
 * clamp guard), not here; the contract just carries the spawned identity onto each
 * `RoleContext`.
 */

import type { AutonomyGrant } from "../../core/trust/contract.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/contract.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";

/** Semantic version of the worker-model contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** The five worker roles, in canonical dispatch order. */
export const WORKER_ROLES = ["scout", "builder", "critic", "verifier", "integrator"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

/** Runtime guard: is `s` a known worker role? */
export function isWorkerRole(s: string): s is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(s);
}

/**
 * Outcome of a role or a whole run. `stub` marks a not-yet-implemented role
 * (pass-1 default) — it is NOT a success and never promotes.
 */
export type WorkerOutcome = "success" | "failure" | "partial" | "rejected" | "stub";

/** Map a worker outcome onto the receipt/trust `OutcomeStatus` (which has no "stub"). */
export function toOutcomeStatus(outcome: WorkerOutcome): "success" | "failure" | "partial" | "rejected" {
  // A stub is an incomplete operation → "partial" (never recorded as success).
  return outcome === "stub" ? "partial" : outcome;
}

/** A unit of work handed to the orchestrator. */
export interface WorkerTask {
  /** Caller-provided correlation id (ties events/receipts together). */
  readonly taskId: string;
  /** Absolute path to the target git repo the work runs against. */
  readonly targetRepo: string;
  /** Human description of the goal. */
  readonly goal: string;
  /** Branch to base + promote into (defaults to the repo's current branch). */
  readonly baseBranch?: string;
  /**
   * OPTIONAL project instructions (the target repo's CLAUDE.md / AGENTS.md), supplied by the
   * caller. When absent, the builder loads it from the worktree root itself. ADDITIVE — it
   * rides into the prompt through the neutralization chokepoint (honored project guidance,
   * but bounded + isolated), never as trusted system text.
   */
  readonly projectInstructions?: string;
  /** Free-form correlation metadata (never secrets). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Write scope constraint for the builder. Controls which files the builder can modify.
   * - "all" (default): builder can create and modify any file in the worktree
   * - "new_only": builder can only CREATE new files; modifying existing files is rejected
   * - "none": builder cannot write any files (read-only audit mode)
   *
   * The cognition layer auto-detects doc/audit/analysis tasks and sets this to "new_only"
   * to prevent the builder from over-writing existing files when the goal is documentation.
   */
  readonly writeScope?: "all" | "new_only" | "none";
  /**
   * Which BUILDER LANE runs this task (the Patchsmith decision #patchsmith):
   * - "agent" (default): the autonomous tool-calling builder (16 tools, run_checks, done).
   * - "patch": the PATCHSMITH lane — no tools. ikbi gathers context, the model returns ONE
   *   unified diff, ikbi applies it in the managed workspace and runs ladder verification.
   *   Cheap models that fail the tool-agent capability bar but can produce clean diffs are
   *   routed here. When absent, the orchestrator resolves the lane from IKBI_BUILDER_MODE.
   */
  readonly builderMode?: "agent" | "patch";
}

/** The result a single role produces. */
export interface RoleResult {
  readonly role: WorkerRole;
  readonly outcome: WorkerOutcome;
  /** Short human summary. */
  readonly summary?: string;
  /** Role-specific structured payload (findings / verdict / feedback). Open shape. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** The overall result of a worker run. */
export interface WorkerResult {
  readonly contractVersion: string;
  readonly taskId: string;
  /** Overall outcome (success only when every role succeeded AND promote landed). */
  readonly outcome: WorkerOutcome;
  /** Per-role results, in dispatch order (short-circuits on the first non-success). */
  readonly roles: readonly RoleResult[];
  /** The workspace this run used (allocated on run). */
  readonly workspaceId?: string;
  /** Whether the workspace was promoted into the target branch. */
  readonly promoted: boolean;
  /** Human reason on a non-success / partial terminal. */
  readonly reason?: string;
  /**
   * Which verification path actually ran this run: "ladder" (HARDENED — stub detection,
   * no-vacuous-green, scope-stamped) or "legacy". Surfaced so an operator never has to inspect
   * env/source to know which path produced the verdict. Absent on pre-dispatch terminals (kill).
   */
  readonly verificationMode?: string;
  /**
   * Which retrieval path actually ran this run: "index" (HARDENED), "legacy", or "index-fallback"
   * (index requested but it failed and fell back to the legacy scan). Surfaced for the same reason.
   */
  readonly retrievalMode?: string;
  /**
   * Total USD cost of EVERY model invocation this run made (summed from each
   * ModelResponse's `cost.usd`, across all roles + competitive candidates). Absent on
   * paths that never invoke a model (e.g. a pre-allocation kill). Surfaced for cost visibility.
   */
  readonly costUsd?: number;
}

/**
 * The engine seams a role builds against. The orchestrator supplies these; roles
 * NEVER reach for the singletons directly. `neutralizeUntrusted` is the MANDATORY
 * #8 seam — the builder must route MCP tool results through it (source
 * "mcp_result") before the model loop, and having it here means the role
 * physically has it and cannot design it out.
 */
export interface RoleEngine {
  /** Invoke a model (caching/egress are transparent below this call). */
  readonly invokeModel: (request: ModelRequest) => Promise<ModelResponse>;
  /** #8: neutralize untrusted content (MCP results, tool output) before the model loop. */
  readonly neutralizeUntrusted: (content: string, context: UntrustedContext) => NeutralizedContent;
}

/**
 * What each role receives. Carries the spawned, ceiling-clamped identity (#10),
 * the autonomy grant for that identity's tier, the isolated workspace, the prior
 * role results, and the engine seams.
 */
export interface RoleContext {
  readonly task: WorkerTask;
  readonly role: WorkerRole;
  /** The spawned identity this role runs under — already clamped to ≤ parent tier. */
  readonly identity: AgentIdentity;
  /** Autonomy for the spawned identity's tier (sandboxing / gating). */
  readonly autonomy: AutonomyGrant;
  /** The isolated workspace the run operates in. */
  readonly workspace: WorkspaceHandle;
  /** Results of roles dispatched before this one (e.g. critic reads builder output). */
  readonly priorResults: readonly RoleResult[];
  /** The engine seams (model + mandatory neutralization). */
  readonly engine: RoleEngine;
}

/** A role: a typed function the orchestrator dispatches. */
export type RoleFn = (ctx: RoleContext) => Promise<RoleResult>;

/** A typed worker-model failure (infrastructure-level; role-level failure is a WorkerResult). */
export class WorkerError extends Error {
  readonly kind:
    | "disabled" // worker-model is disabled in config
    | "escalation" // anti-escalation invariant tripped (#10)
    | "identity" // the parent context is not a validated identity
    | "config" // missing wiring (e.g. role credentials)
    | "workspace" // workspace lifecycle failure
    | "state";
  constructor(kind: WorkerError["kind"], message: string) {
    super(message);
    this.name = "WorkerError";
    this.kind = kind;
  }
}
