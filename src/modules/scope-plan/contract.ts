/**
 * ikbi scope-plan — contract (types only).
 *
 * A SCOPE.md turns a BIG build (a whole greenfield product) into an EXPLICIT, author-ordered
 * sequence of STAGES. Where the step-planner heuristically splits a goal STRING (great for
 * "add X and update Y"), a scope plan is the operator's deliberate module ordering for work the
 * heuristic cannot infer — e.g. "1. core contracts, 2. storage domain, 3. cpu domain, …". Each
 * stage is a SMALL builder pass; the accumulation + final verify/promote reuse the existing
 * shared-workspace multi-step machinery. This is the reliability answer to cheap-model VARIANCE:
 * a bounded pass per stage instead of one giant pass whose file count swings on luck.
 *
 * WHY a file (not a flag): the ordered plan for a real product is many lines and is authored
 * ONCE, then reused across build attempts — it belongs in the repo (SCOPE.md), version-controlled
 * next to the code it describes, not retyped on every invocation.
 */

/** A single ordered stage of a scope plan. */
export interface ScopeStage {
  /** 1-based stage number (source order is authoritative). */
  readonly index: number;
  /** Short human title (the marker line, markers stripped) — for progress lines. */
  readonly title: string;
  /** The full stage goal handed to the builder (title + any body prose). */
  readonly goal: string;
  /** Files this stage is expected to touch (from an explicit `files:` directive). Best-effort context. */
  readonly targetFiles?: readonly string[];
  /**
   * Opt this stage into INTERMEDIATE verification. Default false — an incomplete project often
   * cannot verify mid-build (imports to not-yet-built modules), so intermediate verify is skipped
   * unless the AUTHOR marks a stage `(verify)` to assert it should be independently green (e.g. a
   * self-contained "core contracts" stage). A marked stage that fails verify stops the build EARLY
   * — the reliability win: a broken foundation is caught before later stages pile on top of it.
   */
  readonly verify: boolean;
}

/** A parsed, ordered scope plan. */
export interface ScopePlan {
  /** The ordered stages (source order). Empty ⇒ the file had no recognizable stages. */
  readonly stages: readonly ScopeStage[];
  /** Provenance marker (always "scope" — distinguishes it from a step-planner decomposition). */
  readonly source: "scope";
}
