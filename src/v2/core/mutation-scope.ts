/**
 * ikbi v2 — THE OPERATOR MUTATION SCOPE.
 *
 * The question this file answers is the one the engine could not previously answer at all:
 * WHICH PATHS IS THIS RUN AUTHORIZED TO CHANGE?
 *
 * Before this, the answer was "anything inside the candidate worktree". Confinement kept a
 * build out of the rest of the filesystem, and nothing kept it out of the rest of the
 * repository. The only narrower statements were the operator's goal PROSE and the critic's
 * `scope_violation` category — a model reading English, and a model judging afterwards.
 * Neither is an authority: prose is not a boundary, and a judgment that arrives after the
 * edit cannot refuse it.
 *
 * SO THE SCOPE IS STRUCTURED, AND IT COMES FROM THE OPERATOR ONLY.
 *
 *   The model may not add an entry, widen one, or name a path outside them. There is no tool
 *   that takes a scope, and nothing here reads the goal. That is deliberate: the moment a
 *   scope can be derived from text the model writes or influences, it stops being authority
 *   and becomes a suggestion. A build with no scope does not fall back to the repository —
 *   it does not start.
 *
 * WHY `create`/`modify`/`delete` ARE NOT ONE PERMISSION. They are different powers over
 * different states. Creating `src/lib.rs` when it is absent, rewriting it when it exists, and
 * removing it entirely are three distinct effects on the operator's repository, and the
 * evidence has to name which one was authorized — "the build changed src/" is not an account
 * of anything. So every decision is made per operation and recorded per operation. The CLI
 * grants all three on each entry it accepts today; the type does not assume that, which is
 * what lets a future committed manifest narrow an entry to, say, modify-only without a
 * redesign.
 *
 * REPOSITORY MANIFESTS (deferred, stated here so the direction is fixed): a manifest committed
 * to the repository may only NARROW operator authority, by INTERSECTION with the scope on this
 * page. It can never widen it and can never introduce an entry the operator did not grant —
 * otherwise a repository could authorize edits to itself, and a candidate that can edit the
 * manifest could authorize its own next edit.
 *
 * This module is PURE: normalization, canonicalization, identity, and decisions. It performs
 * no I/O, resolves no symlink, and holds no capability. Filesystem-authoritative checks
 * (symlink escape, real containment) belong to the runtime that owns the workspace, and are
 * a SEPARATE layer — this one cannot be fooled by the filesystem because it never asks it.
 */

import { contentDigest, type V2Digest } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The three distinct effects a mutation can have on a path. Never interchangeable. */
export const MUTATION_OPERATIONS = ["create", "modify", "delete"] as const;
export type MutationOperationKind = (typeof MUTATION_OPERATIONS)[number];

export function isMutationOperation(s: string): s is MutationOperationKind {
  return (MUTATION_OPERATIONS as readonly string[]).includes(s);
}

/**
 *   file  EXACTLY this path. A sibling is not covered, and neither is anything below it.
 *   tree  this directory and everything beneath it, at any depth.
 */
export type MutationScopeEntryKind = "file" | "tree";

/** One grant. Canonical: the path is normalized and the operations are sorted and unique. */
export interface MutationScopeEntry {
  readonly kind: MutationScopeEntryKind;
  /** Repository-relative, `/`-separated, no leading or trailing separator, no `.`/`..`. */
  readonly path: string;
  readonly operations: readonly MutationOperationKind[];
}

/** Content address of a canonical scope. Two identical authorities have the same id. */
export type V2MutationScopeId = V2Digest<"mutation_scope">;

/**
 *   narrow     only the listed entries may change.
 *   repo_wide  the whole repository may change — an EXPLICIT operator act, never a default
 *              and never a fallback. It exists because some legitimate work (a rename across
 *              a codebase, a dependency bump) genuinely has no small path set, and forcing an
 *              operator to fake one with a huge list would teach them to always pass it.
 */
export type MutationScopeKind = "narrow" | "repo_wide";

/** THE immutable authority for what one run may change. */
export interface MutationScope {
  readonly scopeId: V2MutationScopeId;
  readonly kind: MutationScopeKind;
  /** Sorted, minimal, non-overlapping. Empty iff `repo_wide`. */
  readonly entries: readonly MutationScopeEntry[];
}

/** The UNVALIDATED form, as it arrives from a CLI or an HTTP body. */
export interface MutationScopeRequest {
  readonly allowPaths?: readonly string[];
  readonly allowTrees?: readonly string[];
  readonly repoWide?: boolean;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** A generous ceiling. A scope larger than this is a mistake or a paste, not an intent. */
export const MAX_SCOPE_ENTRIES = 512;
/** Longer than any real repository path; a guard against a pathological argument. */
export const MAX_SCOPE_PATH_CHARS = 1_024;

/**
 * Paths whose contents define git's own state rather than the project's.
 *
 * Refused as scope entries because "you may edit `.git`" is not a statement about source: it
 * authorizes rewriting refs, hooks and the object store — which is authority over the
 * repository's history and over what a hook will execute, not over its code.
 */
const GIT_INTERNAL_ROOT = ".git";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Why one supplied path could not become a canonical scope entry. Closed set. */
export type ScopePathRejectionCode =
  | "path_empty"
  | "path_nul"
  | "path_absolute"
  | "path_traversal"
  | "path_dot_only"
  | "path_too_long"
  | "path_git_internal";

export type ScopePathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: ScopePathRejectionCode; readonly detail: string };

/**
 * Normalize one operator-supplied path into canonical repository-relative form.
 *
 * Two different spellings of the same path must produce the same entry, or the scope id
 * would depend on typing rather than on authority: `src/lib.rs`, `./src/lib.rs`,
 * `src//lib.rs` and `src\lib.rs` are one grant, not four.
 *
 * Everything that could mean "somewhere else" is REFUSED rather than repaired. `..` is not
 * resolved away — a path that tried to leave is a mistake worth reporting, and silently
 * rewriting `src/../etc` into `etc` would grant something nobody asked for.
 */
export function normalizeScopePath(raw: string): ScopePathResult {
  if (raw.includes("\0")) {
    return { ok: false, code: "path_nul", detail: "a path may not contain a NUL byte" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "path_empty", detail: "a path may not be empty" };
  }
  if (trimmed.length > MAX_SCOPE_PATH_CHARS) {
    return { ok: false, code: "path_too_long", detail: `a path may be at most ${MAX_SCOPE_PATH_CHARS} characters (got ${trimmed.length})` };
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { ok: false, code: "path_absolute", detail: `"${raw}" is absolute — scope paths are repository-relative` };
  }
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) {
    return { ok: false, code: "path_traversal", detail: `"${raw}" contains ".." — a scope entry may not traverse out of the repository` };
  }
  const kept = segments.filter((s) => s.length > 0 && s !== ".");
  if (kept.length === 0) {
    return { ok: false, code: "path_dot_only", detail: `"${raw}" names the repository root, not a file or subtree — use --allow-repo-wide if that is the intent` };
  }
  if (kept[0] === GIT_INTERNAL_ROOT) {
    return { ok: false, code: "path_git_internal", detail: `"${raw}" is inside ${GIT_INTERNAL_ROOT} — git's own state is never in scope` };
  }
  return { ok: true, path: kept.join("/") };
}

/**
 * Is `path` the same as, or beneath, the directory `tree`? Both already normalized.
 *
 * The INCLUSIVE relation, used for reasoning about containment between scope entries
 * (redundancy, nesting). For deciding a mutation, see `isBeneathTree`.
 */
export function isWithinTree(path: string, tree: string): boolean {
  return path === tree || path.startsWith(`${tree}/`);
}

/**
 * Is `path` strictly BENEATH the directory `tree`?
 *
 * The relation a mutation decision uses, and the difference from `isWithinTree` is
 * deliberate. `--allow-tree src` grants the DIRECTORY `src` and its contents. A mutation
 * whose path is exactly `src` is not a change inside that directory — it is a change to an
 * object of the same name, and a `create`/`delete` there would replace the granted subtree
 * with a file. The subtree grant does not extend to destroying the subtree.
 */
export function isBeneathTree(path: string, tree: string): boolean {
  return path.startsWith(`${tree}/`);
}

// ---------------------------------------------------------------------------
// Building the scope
// ---------------------------------------------------------------------------

/** Why a whole scope request was refused. Closed set — every refusal is explainable. */
export type ScopeRejectionCode =
  | ScopePathRejectionCode
  | "scope_absent"
  | "repo_wide_with_entries"
  | "duplicate_entry"
  | "redundant_entry"
  | "conflicting_entry"
  | "too_many_entries";

export type MutationScopeResult =
  | { readonly ok: true; readonly scope: MutationScope }
  | { readonly ok: false; readonly code: ScopeRejectionCode; readonly detail: string };

/** Canonical order: by path, then files before trees. Deterministic, so the id is. */
function compareEntries(a: MutationScopeEntry, b: MutationScopeEntry): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.kind === b.kind ? 0 : a.kind === "file" ? -1 : 1;
}

/** Compute the content address of a canonical scope. */
export function mutationScopeDigest(input: { readonly kind: MutationScopeKind; readonly entries: readonly MutationScopeEntry[] }): V2MutationScopeId {
  return contentDigest("mutation_scope", {
    kind: input.kind,
    entries: input.entries.map((e) => ({ kind: e.kind, path: e.path, operations: [...e.operations] })),
  });
}

/**
 * Validate an operator scope request into THE canonical authority, or refuse it.
 *
 * FAIL-CLOSED IN BOTH DIRECTIONS. An absent scope is refused rather than defaulted to the
 * repository, and `--allow-repo-wide` combined with narrower entries is refused rather than
 * quietly resolved — the two readings ("everything" and "only these") are contradictory, and
 * picking one for the operator would be picking the dangerous one half the time.
 *
 * MINIMALITY IS REQUIRED, NOT INFERRED. A file already covered by an allowed tree, or a tree
 * nested inside another, is refused as redundant instead of being absorbed. Two spellings of
 * one authority would otherwise produce two different scope ids, and a scope id that depends
 * on how the operator happened to type it is not an identity.
 */
export function buildMutationScope(request: MutationScopeRequest | undefined): MutationScopeResult {
  const allowPaths = request?.allowPaths ?? [];
  const allowTrees = request?.allowTrees ?? [];
  const repoWide = request?.repoWide === true;

  if (repoWide && (allowPaths.length > 0 || allowTrees.length > 0)) {
    return {
      ok: false,
      code: "repo_wide_with_entries",
      detail: "--allow-repo-wide grants the whole repository and cannot be combined with --allow-path/--allow-tree; pass one or the other",
    };
  }

  if (repoWide) {
    const entries: readonly MutationScopeEntry[] = Object.freeze([]);
    return { ok: true, scope: Object.freeze({ scopeId: mutationScopeDigest({ kind: "repo_wide", entries }), kind: "repo_wide", entries }) };
  }

  if (allowPaths.length === 0 && allowTrees.length === 0) {
    return {
      ok: false,
      code: "scope_absent",
      detail: "no mutation scope was given — a build must state what it may change (--allow-path/--allow-tree, or --allow-repo-wide)",
    };
  }
  if (allowPaths.length + allowTrees.length > MAX_SCOPE_ENTRIES) {
    return { ok: false, code: "too_many_entries", detail: `a scope may hold at most ${MAX_SCOPE_ENTRIES} entries (got ${allowPaths.length + allowTrees.length})` };
  }

  const files: string[] = [];
  const trees: string[] = [];
  for (const raw of allowPaths) {
    const normalized = normalizeScopePath(raw);
    if (!normalized.ok) return { ok: false, code: normalized.code, detail: `--allow-path ${normalized.detail}` };
    files.push(normalized.path);
  }
  for (const raw of allowTrees) {
    const normalized = normalizeScopePath(raw);
    if (!normalized.ok) return { ok: false, code: normalized.code, detail: `--allow-tree ${normalized.detail}` };
    trees.push(normalized.path);
  }

  // A path given as BOTH an exact file and a directory tree is contradictory: one says "this
  // file only", the other "everything under this name". Refuse rather than choose.
  for (const file of files) {
    if (trees.includes(file)) {
      return { ok: false, code: "conflicting_entry", detail: `"${file}" was given as both --allow-path and --allow-tree — a path is either an exact file or a subtree` };
    }
  }

  const seenFiles = new Set<string>();
  for (const file of files) {
    if (seenFiles.has(file)) return { ok: false, code: "duplicate_entry", detail: `--allow-path "${file}" was given more than once` };
    seenFiles.add(file);
  }
  const seenTrees = new Set<string>();
  for (const tree of trees) {
    if (seenTrees.has(tree)) return { ok: false, code: "duplicate_entry", detail: `--allow-tree "${tree}" was given more than once` };
    seenTrees.add(tree);
  }

  for (const tree of trees) {
    for (const other of trees) {
      if (other !== tree && isWithinTree(tree, other)) {
        return { ok: false, code: "redundant_entry", detail: `--allow-tree "${tree}" is already covered by --allow-tree "${other}" — drop the narrower one` };
      }
    }
  }
  for (const file of files) {
    for (const tree of trees) {
      if (isWithinTree(file, tree)) {
        return { ok: false, code: "redundant_entry", detail: `--allow-path "${file}" is already covered by --allow-tree "${tree}" — drop it` };
      }
    }
  }

  // Today every accepted entry carries all three operations; the SHAPE keeps them separable
  // so a manifest intersection can later hand back a modify-only entry without a redesign.
  const all: readonly MutationOperationKind[] = Object.freeze([...MUTATION_OPERATIONS]);
  const entries: MutationScopeEntry[] = [
    ...files.map((path): MutationScopeEntry => ({ kind: "file", path, operations: all })),
    ...trees.map((path): MutationScopeEntry => ({ kind: "tree", path, operations: all })),
  ].sort(compareEntries);

  const frozen = Object.freeze(entries.map((e) => Object.freeze({ ...e, operations: Object.freeze([...e.operations]) })));
  return { ok: true, scope: Object.freeze({ scopeId: mutationScopeDigest({ kind: "narrow", entries: frozen }), kind: "narrow", entries: frozen }) };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Why one mutation was refused by the scope. Closed set. */
export type ScopeDenialCode = "out_of_scope" | "operation_not_authorized" | "path_unusable";

export type ScopeDecision =
  | { readonly allowed: true; readonly path: string; readonly operation: MutationOperationKind; readonly matched: MutationScopeEntry | "repo_wide" }
  | { readonly allowed: false; readonly path: string; readonly operation: MutationOperationKind; readonly code: ScopeDenialCode; readonly detail: string };

/**
 * May this run perform THIS operation on THIS path?
 *
 * The path is normalized here rather than trusted, because the caller's path came from a
 * model: `src/./lib.rs` and `src/lib.rs` must reach the same answer, and a path that cannot
 * be normalized is refused rather than guessed at.
 *
 * Note what `repo_wide` still refuses: an unusable path, and anything under `.git`. "The
 * whole repository" means the project's files, not git's own state.
 */
export function decideMutation(scope: MutationScope, input: { readonly path: string; readonly operation: MutationOperationKind }): ScopeDecision {
  const { operation } = input;
  const normalized = normalizeScopePath(input.path);
  if (!normalized.ok) {
    return { allowed: false, path: input.path, operation, code: "path_unusable", detail: normalized.detail };
  }
  const path = normalized.path;

  if (scope.kind === "repo_wide") {
    return { allowed: true, path, operation, matched: "repo_wide" };
  }

  const matched = scope.entries.find((e) => (e.kind === "file" ? e.path === path : isBeneathTree(path, e.path)));
  if (matched === undefined) {
    return {
      allowed: false,
      path,
      operation,
      code: "out_of_scope",
      detail: `"${path}" is outside this run's authorized mutation scope (${describeScope(scope)})`,
    };
  }
  if (!matched.operations.includes(operation)) {
    return {
      allowed: false,
      path,
      operation,
      code: "operation_not_authorized",
      detail: `"${path}" may be ${matched.operations.join("/")}d here, but not ${operation}d`,
    };
  }
  return { allowed: true, path, operation, matched };
}

/** A one-line human rendering of the authority. Used in refusals and in the builder prompt. */
export function describeScope(scope: MutationScope): string {
  if (scope.kind === "repo_wide") return "the whole repository";
  return scope.entries.map((e) => (e.kind === "tree" ? `${e.path}/**` : e.path)).join(", ");
}

// ---------------------------------------------------------------------------
// Publication review
// ---------------------------------------------------------------------------

/** One changed path, with the effect that produced it, as publication sees it. */
export interface ScopedChange {
  readonly path: string;
  readonly operation: MutationOperationKind;
}

export interface ScopeViolation {
  readonly path: string;
  readonly operation: MutationOperationKind;
  readonly code: ScopeDenialCode;
  readonly detail: string;
}

/**
 * Re-decide the FINAL set of changed paths against the scope.
 *
 * A last, independent check at the publication boundary. The per-mutation gate already
 * refused out-of-scope edits, so in an honest run this finds nothing — which is exactly why
 * it is worth running: it is the assertion that the enforcement upstream actually held, and
 * it catches any path that reached the tree by a route the mutation gate does not own.
 */
export function reviewChangedPaths(scope: MutationScope, changes: readonly ScopedChange[]): readonly ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const change of changes) {
    const decision = decideMutation(scope, change);
    if (!decision.allowed) {
      violations.push({ path: change.path, operation: change.operation, code: decision.code, detail: decision.detail });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Receipt view
// ---------------------------------------------------------------------------

/** A receipt-safe rendering of the authority a run held. */
export interface RunMutationScopeSummary {
  readonly scopeId: string;
  readonly kind: MutationScopeKind;
  readonly entries: readonly { readonly kind: MutationScopeEntryKind; readonly path: string; readonly operations: readonly string[] }[];
  readonly description: string;
}

export function summarizeMutationScope(scope: MutationScope): RunMutationScopeSummary {
  return {
    scopeId: scope.scopeId,
    kind: scope.kind,
    entries: scope.entries.map((e) => ({ kind: e.kind, path: e.path, operations: [...e.operations] })),
    description: describeScope(scope),
  };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_SCOPE_FAILURE_CODES = {
  /** No usable scope was supplied. Refused in preflight, before any provider or workspace. */
  scopeRequired: "task.mutation_scope_required",
  /** A scope was supplied but is not well-formed. */
  scopeInvalid: "task.mutation_scope_invalid",
  /** A candidate's final changed paths left the authorized scope. Publication is refused. */
  publicationOutOfScope: "promotion.changed_paths_out_of_scope",
} as const;

/** The preflight refusal for a missing or malformed scope. */
export function mutationScopeFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "task",
    code,
    message,
    stage: "preflight",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

/** The publication refusal for a candidate that changed something it was not authorized to. */
export function publicationScopeFailure(violations: readonly ScopeViolation[], scope: MutationScope): RunFailure {
  const named = violations.slice(0, 10).map((v) => `${v.operation} ${v.path}`).join(", ");
  return runFailure({
    category: "promotion",
    code: V2_SCOPE_FAILURE_CODES.publicationOutOfScope,
    message:
      `refusing to publish: ${violations.length} change(s) fall outside the authorized mutation scope ` +
      `(${describeScope(scope)}) — ${named}${violations.length > 10 ? ", …" : ""}`,
    stage: "promotion",
    retryable: false,
    detail: { scopeId: scope.scopeId, violations: violations.length },
  });
}
