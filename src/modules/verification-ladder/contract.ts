/**
 * ikbi verification-ladder — contract types (PLANNER ONLY).
 *
 * Turns (changed files + a project-index) into an ordered, scoped, reasoned verification PLAN:
 * nearest tests → package checks → full repo checks (only when required). DETERMINISTIC, no
 * execution, no model calls. The executor (a later step) runs the plan; this module only decides
 * WHAT should run and WHY, and — critically — when it is UNSAFE to declare success.
 *
 * SOUNDNESS INVARIANT: "green means the target passed." Impact analysis is heuristic, so the
 * planner escalates to full verification whenever scope is uncertain. And if full verification is
 * REQUIRED but no runnable full checks can be derived, the plan is BLOCKED (status:"blocked" + a
 * non-runnable blocking marker) — it must NEVER yield a passable empty full stage.
 *
 * @status dormant (library-only); nothing executes or wires this yet.
 */

import type { ProjectIndexData } from "../project-index/index.js";

export type CheckScope = "nearest" | "package" | "full";
export type CheckStageName = "nearest-tests" | "package-checks" | "full";

/** One unit of verification work (the executor turns this into a governed-exec call). */
export interface CheckTask {
  /** Package root this task belongs to ("" = repo root). */
  readonly package: string;
  /** Repo-relative dir to run in ("" = repo root). */
  readonly cwd: string;
  /** Logical check name, e.g. "test" | "typecheck" | "build". */
  readonly name: string;
  /** Binary to run (e.g. "pnpm"). EMPTY for a blocking marker — never runnable. */
  readonly command: string;
  readonly args: readonly string[];
  readonly scope: CheckScope;
  /** Why this task is in the plan. */
  readonly reason: string;
  /** nearest-stage: the specific test files to narrow to, if the runner supports it. */
  readonly targets?: readonly string[];
  /**
   * A non-runnable BLOCKING marker (command === ""). Its presence means the plan CANNOT pass:
   * full verification was required but could not be derived. An executor MUST fail closed on it
   * and must never interpret it (or an empty stage) as success.
   */
  readonly blocking?: boolean;
}

export interface CheckStage {
  readonly stage: CheckStageName;
  readonly tasks: readonly CheckTask[];
}

export interface VerificationPlan {
  /** "ok" = runnable plan; "blocked" = required full verification is unavailable (never passable). */
  readonly status: "ok" | "blocked";
  /** Convenience mirror of status === "blocked". */
  readonly blocked: boolean;
  /** When blocked: why full verification is required AND why it couldn't be derived. */
  readonly blockReasons: readonly string[];
  /** The verdict scope the executor will stamp: "impact" (subset) or "full". */
  readonly scope: "impact" | "full";
  readonly escalateToFull: boolean;
  readonly escalationReasons: readonly string[];
  readonly affectedPackages: readonly string[];
  readonly affectedTests: readonly string[];
  /** Affected packages with NO runnable check (no test/typecheck/build script) — never counted green. */
  readonly neutralPackages: readonly string[];
  /** Stub/no-op verification scripts found ("<pkg>:<key>", e.g. a `test` that is `echo pass`) —
   *  recorded and NEVER counted as green unless trivial scripts are operator-trusted. */
  readonly stubScripts: readonly string[];
  /** Ordered stages: nearest-tests → package-checks → full. */
  readonly stages: readonly CheckStage[];
  /** Decision trail. */
  readonly receipts: readonly string[];
}

/** An operator-supplied full-repo check (escape hatch when the repo has no root test script). */
export interface FullCheckOverride {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface PlanOptions {
  /** Force the full stage regardless of impact (e.g. an operator policy). */
  readonly alwaysFull?: boolean;
  /** Operator-supplied full checks; used as the full stage when present (overrides root-package derivation). */
  readonly fullChecks?: readonly FullCheckOverride[];
}

export interface PlanRequest {
  readonly data: ProjectIndexData;
  /** Repo-relative POSIX paths of the changed files (from the workspace diff). */
  readonly changedFiles: readonly string[];
  readonly opts?: PlanOptions;
}

export interface VerificationLadderApi {
  planVerification(req: PlanRequest): VerificationPlan;
}
