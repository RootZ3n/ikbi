/**
 * ikbi v2 — THE PUBLIC CONTRACTS AND THE ARCHITECTURAL SEAMS.
 *
 * Two jobs:
 *
 *  1. Define the TASK — what an operator (or the server, or the REPL) hands to the
 *     canonical run function.
 *  2. Define the SEAMS that later slices plug into, in exactly enough detail that a
 *     later slice cannot accidentally design itself into a corner. Nothing here is
 *     implemented in this slice. What matters is that these shapes are chosen NOW,
 *     because the two capabilities they protect are the ones v1 proves are easy to
 *     lose: multi-candidate strategies, and state-bound mutation.
 *
 * SEAM 1 — CANDIDATE STRATEGY (why shadow + tournament survive).
 *   The lifecycle never assumes one task = one builder = one candidate. A strategy
 *   decides HOW candidates are produced and how many; the lifecycle then verifies
 *   and adjudicates ALL of them through the same single authority. That is the whole
 *   architectural trick: shadow workspaces and the tournament stay first-class
 *   features without ever becoming parallel spines with their own promote paths.
 *
 * SEAM 2 — STATE-BOUND MUTATION (hash-anchored editing).
 *   Every mutation must be anchored to an explicitly OBSERVED state carrying a
 *   content hash, and applied with compare-and-swap semantics: if the target changed
 *   after the observation, the edit FAILS and the caller must re-observe. The types
 *   below make the unsafe form unsayable — a mutation request cannot be constructed
 *   from a path alone; it requires an observation id AND the observed state identity.
 *   Every mutation mode (builder, repair, shadow, tournament candidate, REPL) must
 *   route through one implementation of `StateBoundMutationAuthority`.
 */

import type { V2CandidateId, V2ObservationId, V2WorkspaceId } from "./identity.js";
import type { MutationScope, MutationScopeRequest } from "./mutation-scope.js";

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

/** How candidates are produced for a task. Strategies, not lifecycles. */
export const CANDIDATE_STRATEGIES = ["single", "shadow", "tournament"] as const;
export type CandidateStrategyKind = (typeof CANDIDATE_STRATEGIES)[number];

/** Runtime guard: is `s` a known candidate strategy? */
export function isCandidateStrategyKind(s: string): s is CandidateStrategyKind {
  return (CANDIDATE_STRATEGIES as readonly string[]).includes(s);
}

/**
 * A unit of operator intent handed to the canonical v2 entrypoint — the UNVALIDATED
 * form. `candidateStrategy` is a raw string because it arrives from outside (a CLI
 * flag, an HTTP body); preflight validates it into the closed enum. Same claim-vs-
 * validated posture the frozen identity core uses: untrusted input never types
 * itself into the engine.
 */
export interface V2TaskRequest {
  /** What the operator wants done. */
  readonly goal: string;
  /** Path to the target repository (resolved to absolute during preflight). */
  readonly repoPath: string;
  /** How candidates should be produced. Defaults to "single". Validated in preflight. */
  readonly candidateStrategy?: string;
  /**
   * PER-RUN PROFILE OVERRIDE — the highest configuration precedence layer. When set,
   * it replaces the operator's standing active-profile selection for this run only,
   * and it never writes the active-profile pointer. An override that cannot be
   * resolved fails preflight exactly like a broken standing selection would.
   */
  readonly profile?: string;
  /**
   * WHICH PATHS THIS RUN MAY CHANGE — the operator's structured authority.
   *
   * Optional ON THIS TYPE because the request is the UNVALIDATED form and an absent scope has
   * to be representable in order to be REFUSED. It is not optional in effect: preflight turns
   * an absent or malformed scope into a failure before any provider is reached or any
   * workspace exists. There is no default, and "no scope" never means "the repository".
   */
  readonly mutationScope?: MutationScopeRequest;
}

/** The task after normalization/validation. What the lifecycle actually carries. */
export interface V2Task {
  readonly goal: string;
  readonly repoPath: string;
  readonly candidateStrategy: CandidateStrategyKind;
  /**
   * The canonical, validated authority. REQUIRED here: past preflight there is no such thing
   * as a run without a scope, and making the field optional would let some later caller
   * construct one and inherit repository-wide authority by omission.
   */
  readonly mutationScope: MutationScope;
}

// ---------------------------------------------------------------------------
// SEAM 1 — candidate strategy
// ---------------------------------------------------------------------------

/**
 * A strategy's declared shape. `maxCandidates` is a CEILING the lifecycle can check
 * against the candidates actually recorded — so a "single" strategy that somehow
 * produced three is a detectable violation rather than a silent surprise.
 */
export interface CandidateStrategyPlan {
  readonly kind: CandidateStrategyKind;
  readonly maxCandidates: number;
}

/** Default plans. Real bounds (tournament width, shadow depth) belong to a later slice. */
export function defaultStrategyPlan(kind: CandidateStrategyKind): CandidateStrategyPlan {
  // "single" is 1 by definition. shadow/tournament are >1 by definition; their real
  // widths are configuration a later slice owns, so only the >1 fact is fixed here.
  return { kind, maxCandidates: kind === "single" ? 1 : 2 };
}

/**
 * The seam a later slice implements, once per strategy. It produces candidates —
 * it does NOT verify, adjudicate, or promote them. Deliberately unimplemented here.
 */
export interface CandidateProducer {
  readonly plan: CandidateStrategyPlan;
  /** Produce candidates for the task. Each is bound to its own isolated workspace. */
  produce(task: V2Task): Promise<readonly ProducedCandidate[]>;
}

/** A candidate as handed back to the lifecycle: an identity bound to a workspace. */
export interface ProducedCandidate {
  readonly candidateId: V2CandidateId;
  readonly workspaceId: V2WorkspaceId;
}

// ---------------------------------------------------------------------------
// SEAM 2 — state-bound (hash-anchored) mutation
// ---------------------------------------------------------------------------

/** Filesystem kinds a state-bound observation distinguishes. Mirrors the v1 donor. */
export type ObservedKind = "missing" | "empty" | "regular" | "directory" | "symlink";

/**
 * The content IDENTITY of an observed path — the anchor a compare-and-swap tests
 * against. Mode is intentionally absent: permissions are not content identity.
 */
export interface ObservedStateIdentity {
  readonly kind: ObservedKind;
  /** SHA-256 of the exact bytes observed (or of a symlink target). Null for kinds with no bytes. */
  readonly sha256: string | null;
  readonly byteLength: number | null;
  readonly symlinkTarget: string | null;
}

/** One observation: a path, in a workspace, at a state, with its own identity. */
export interface StateObservation {
  readonly observationId: V2ObservationId;
  readonly workspaceId: V2WorkspaceId;
  /** Workspace-relative path. Never absolute — mutations are workspace-confined. */
  readonly path: string;
  readonly state: ObservedStateIdentity;
  readonly observedAt: number;
}

/**
 * A mutation request. NOTE WHAT IS REQUIRED: an observation id and the observed
 * state identity. There is deliberately no constructor that takes only a path — a
 * later slice physically cannot write "edit this file" without first having observed
 * it, which is the invariant this seam exists to protect.
 */
export interface StateBoundMutationRequest {
  readonly observationId: V2ObservationId;
  readonly workspaceId: V2WorkspaceId;
  readonly path: string;
  /** The state the caller believes the target is in. The CAS compares against this. */
  readonly expected: ObservedStateIdentity;
  readonly operation: "create" | "replace" | "delete";
  /** The complete resulting bytes for create/replace. Absent for delete. */
  readonly content?: Readonly<Uint8Array>;
}

/** Why a state-bound mutation was refused. Closed set; fail-closed by construction. */
export type MutationRejectionCode =
  | "stale_observation"
  | "unobserved_target"
  | "observation_foreign_workspace"
  | "path_escapes_workspace"
  | "unsupported_target_kind";

/** The result of attempting a state-bound mutation. */
export type StateBoundMutationResult =
  | { readonly applied: true; readonly before: ObservedStateIdentity; readonly after: ObservedStateIdentity }
  | { readonly applied: false; readonly code: MutationRejectionCode; readonly message: string };

/**
 * THE single mutation authority every v2 mutation mode must route through.
 * Unimplemented in this slice — the contract exists so that when it IS implemented,
 * there is exactly one owner and no mode can quietly write bytes another way.
 */
export interface StateBoundMutationAuthority {
  observe(workspaceId: V2WorkspaceId, path: string): Promise<StateObservation>;
  apply(request: StateBoundMutationRequest): Promise<StateBoundMutationResult>;
}

/**
 * The compare-and-swap predicate itself — pure, dependency-free, and shipped NOW so
 * the semantics are pinned by tests before any engine exists to get them wrong.
 * Two states match only if kind, hash, length and symlink target all agree; anything
 * else means the world moved and the caller must re-observe.
 */
export function sameObservedState(left: ObservedStateIdentity, right: ObservedStateIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength &&
    left.symlinkTarget === right.symlinkTarget
  );
}

/** True when `current` has drifted from what was observed — the edit MUST be refused. */
export function isStaleObservation(observed: ObservedStateIdentity, current: ObservedStateIdentity): boolean {
  return !sameObservedState(observed, current);
}
