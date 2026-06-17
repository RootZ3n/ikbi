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

/**
 * The five worker roles, in canonical dispatch order.
 *
 * The CRITIC runs AFTER the VERIFIER (not before): a critic that has already seen
 * "tests green, typecheck clean" can specialize in the semantic/goal-alignment
 * concerns objective checks cannot catch, instead of judging blind. The integrator's
 * AND-gate reads every role's result from priorResults and is order-independent.
 */
export const WORKER_ROLES = ["scout", "builder", "verifier", "critic", "integrator"] as const;
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

// ── Pehlichi Delegation ───────────────────────────────────────────────────────

/**
 * Structured envelope for delegation requests from an orchestrator agent (e.g. Pehlichi).
 * Carries the origin, governance metadata, and task parameters as a typed unit.
 */
export interface DelegationEnvelope {
  /** The agent issuing this delegation (e.g. 'pehlichi'). */
  readonly originAgent: string;
  /** The human operator who approved this delegation. Required when `approvalRequired` is true. */
  readonly humanOperator?: string | undefined;
  /** Absolute path to the target repository. */
  readonly repoPath: string;
  /** Branch to work on. */
  readonly targetBranch?: string | undefined;
  /** The kind of work being delegated. */
  readonly taskType: "build" | "audit" | "fix";
  /** The goal text passed to the worker pipeline. */
  readonly objective: string;
  /** Additional constraints forwarded to the pipeline. */
  readonly constraints?: readonly string[] | undefined;
  /** Whether human approval is required before the run starts. */
  readonly approvalRequired?: boolean | undefined;
  /** Tool restrictions (passed through as advisory metadata). */
  readonly allowedTools?: readonly string[] | undefined;
  /** Where to send receipts (advisory — receipt routing is not yet wired). */
  readonly receiptDestination?: string | undefined;
  /** Conditions under which the run should stop early. */
  readonly stopConditions?: readonly string[] | undefined;
}

/** Typed validation result for a DelegationEnvelope. */
export type DelegationValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * Validate a DelegationEnvelope before dispatching a delegation run.
 * Returns `{ valid: true }` on success, or `{ valid: false, reason }` on the first violation.
 */
export function validateDelegationEnvelope(env: DelegationEnvelope): DelegationValidationResult {
  if (env.repoPath.trim().length === 0) {
    return { valid: false, reason: "repoPath must be non-empty" };
  }
  if (env.objective.trim().length === 0) {
    return { valid: false, reason: "objective must be non-empty" };
  }
  const validTypes: ReadonlyArray<DelegationEnvelope["taskType"]> = ["build", "audit", "fix"];
  if (!validTypes.includes(env.taskType)) {
    return { valid: false, reason: `taskType must be one of: ${validTypes.join(", ")}` };
  }
  if (env.approvalRequired === true && (env.humanOperator === undefined || env.humanOperator.trim().length === 0)) {
    return { valid: false, reason: "humanOperator must be set when approvalRequired is true" };
  }
  return { valid: true };
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
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The orchestrator agent that delegated this task (e.g. 'pehlichi'). Stamped into the
   * run summary receipt when present so the audit trail records the delegation source.
   */
  readonly originAgent?: string | undefined;
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
   * - "agent" (default): the autonomous tool-calling builder (full tool suite, run_checks, done).
   * - "patch": the PATCHSMITH lane — no tools. ikbi gathers context, the model returns ONE
   *   unified diff, ikbi applies it in the managed workspace and runs ladder verification.
   *   Cheap models that fail the tool-agent capability bar but can produce clean diffs are
   *   routed here. When absent, the orchestrator resolves the lane from IKBI_BUILDER_MODE.
   */
  readonly builderMode?: "agent" | "patch";
  /**
   * TOURNAMENT candidate models (the candidate-tournament decision #tournament). When present and
   * non-empty, the orchestrator runs a CANDIDATE TOURNAMENT instead of the single-workspace path:
   * each listed model independently attempts this task in its OWN isolated workspace, ikbi verifies
   * + scores ALL of them deterministically (no model judge), and the WINNER's diff is replayed into
   * a CLEAN shadow workspace and re-verified before the EXISTING promote path runs. Models propose;
   * ikbi verifies + scores; one winner; no model-to-model communication; no merging. When absent,
   * the orchestrator resolves the candidate list from IKBI_CANDIDATE_MODELS (empty ⇒ no tournament).
   */
  readonly candidates?: readonly string[];
  /**
   * STEP-PLANNER: reuse an existing workspace instead of allocating a new one.
   * When set, the orchestrator skips workspace allocation and runs in the
   * provided handle. Used by the step planner to share a single workspace
   * across multiple sequential steps so changes accumulate.
   */
  readonly reuseWorkspace?: import("../../core/workspace/contract.js").WorkspaceHandle;
  /**
   * STEP-PLANNER: run the full role pipeline (scout → builder → critic → verifier)
   * but SKIP the promote/discard lifecycle at the end. The workspace stays alive
   * on disk so the next step (or a final verification pass) can continue.
   * When false (default), the orchestrator promotes or discards as usual.
   */
  readonly skipPromote?: boolean;
  /**
   * STEP-PLANNER: skip the verifier role entirely. Used for intermediate steps
   * where verification doesn't make sense (e.g., scaffold step in a greenfield
   * project — no tests exist yet). The final step runs verification normally.
   */
  readonly skipVerifier?: boolean;
  /**
   * STEP-PLANNER: skip the CRITIC role entirely. Used for intermediate steps whose
   * critique would be both meaningless and wasted: the critic judges a PARTIAL build
   * against a sub-goal, its model verdict is discarded (an intermediate step sets
   * `skipPromote`, so the integrator's decision never runs, and a critic FAIL still
   * returns `outcome:"success"` so it never stops the step). Skipping it removes a paid
   * model call per intermediate step. The final step runs the critic normally. DEFAULT
   * OFF — only the step planner sets it, so single-pass behavior is byte-unchanged.
   */
  readonly skipCritic?: boolean;
  /**
   * Skip loading project memory (CLAUDE.md / AGENTS.md / IKBI.md / .ikbi/) entirely.
   * When true, the builder does NOT inject any project instructions into the model context.
   * Activated via `--no-memory` on the CLI. Default: false (project memory is loaded).
   */
  readonly skipProjectMemory?: boolean | undefined;
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
  /**
   * The escalation engine's recommendation for this run, surfaced so an operator can ACT on it
   * (e.g. re-run on a higher tier). OBSERVE-ONLY: the orchestrator never swaps models or retries
   * on this — it records the strongest recommendation seen across the scoring roles (a `recommended`
   * one wins over a declined one; ties break on the higher score). Absent when escalation is disabled
   * or no scoring role ran. Wiring this to an actual model swap is a separately-reviewed follow-up.
   */
  readonly escalation?: {
    /** Whether the engine recommended escalating to a higher tier. */
    readonly recommended: boolean;
    /** The tier the run executed at (the cheap `worker` tier). */
    readonly fromTier: string;
    /** The tier the engine recommends escalating to (present when `recommended`). */
    readonly targetTier?: string;
    /** The computed escalation score total. */
    readonly total: number;
    /** Whether the recommended escalation would require human approval. */
    readonly requiresApproval?: boolean;
    /** Why escalation was recommended (target) or declined. */
    readonly reason?: string;
  };
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
