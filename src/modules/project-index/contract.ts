/**
 * ikbi project-index — contract types.
 *
 * A DETERMINISTIC, model-free structural index of a target repo: a file map, a
 * package graph, a TS/JS import graph, and a file→test mapping. It is the foundation
 * for relevance retrieval — NOT symbol intelligence. Boring correctness over AST dreams:
 * imports are extracted by scoped regex and resolved against the known file set; there is
 * no type resolution, no call graph, no semantic understanding.
 *
 * @status dormant (library-only). Nothing wires it into scout/builder/CLI/server yet.
 */

/** The module's own data-shape version (bump on a breaking persisted-shape change). */
export const PROJECT_INDEX_VERSION = 1 as const;

/** Coarse language tag, by file extension. Only the `*-like` JS/TS langs are import-parsed. */
export type Language = "ts" | "tsx" | "js" | "jsx" | "json" | "md" | "other";

/** A package manager, inferred from lockfiles. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "unknown";

/** One file in the repo (repo-relative POSIX path). */
export interface FileEntry {
  /** Repo-relative POSIX path (e.g. "packages/a/src/index.ts"). */
  readonly path: string;
  readonly lang: Language;
  /** Size in bytes (from stat). */
  readonly size: number;
  /** Modification time (ms epoch, from stat) — used as the cheap incremental-refresh probe. */
  readonly mtimeMs: number;
  /** sha256 hex of the file content — the authoritative change signal. */
  readonly hash: string;
  /** True when this file is a test (by name/`__tests__/` convention). */
  readonly isTest: boolean;
  /** Root (repo-relative POSIX) of the nearest enclosing package, or undefined if none. */
  readonly package?: string;
}

/** One package (a directory holding a package.json). */
export interface PackageEntry {
  /** Repo-relative POSIX dir of the package ("" for a repo-root package). */
  readonly root: string;
  readonly name: string;
  readonly manager: PackageManager;
  /** package.json `scripts` verbatim. */
  readonly scripts: Readonly<Record<string, string>>;
  /** Convenience: `<manager> test` when a `test` script exists. */
  readonly testCommand?: string;
  /** Convenience: `<manager> run build` when a `build` script exists. */
  readonly buildCommand?: string;
  /** Workspace member patterns (from `workspaces` / pnpm-workspace.yaml), unexpanded. */
  readonly members?: readonly string[];
  /** Resolved entry file (repo-relative POSIX), if one could be determined. */
  readonly entry?: string;
}

/** How an import specifier was resolved. */
export type ImportKind = "relative" | "package" | "external" | "unresolved" | "alias";

/** One directed import edge (from → to/specifier). */
export interface ImportEdge {
  /** The importing file (repo-relative POSIX). */
  readonly from: string;
  /** The resolved target file (repo-relative POSIX), when `kind` is relative/package. */
  readonly to?: string;
  /** The raw module specifier as written in source. */
  readonly specifier: string;
  readonly kind: ImportKind;
}

/** Git provenance for the indexed working tree (present only when repoPath IS a git root). */
export interface GitProvenance {
  /** Current HEAD commit (full sha). */
  readonly head: string;
  /** Current branch name, or undefined when detached. */
  readonly branch?: string;
  /** Whether the working tree has uncommitted changes (undefined when not cheaply determinable). */
  readonly dirty?: boolean;
  /** Count of changed entries from `git status --porcelain` (when `dirty` is known). */
  readonly changedFiles?: number;
}

/** The full persisted index for one repo. Arrays are sorted for deterministic output. */
export interface ProjectIndexData {
  readonly version: number;
  /** Absolute repo path the index was built for. */
  readonly repoPath: string;
  /** Short stable hash of the absolute repo path (the persistence key). */
  readonly repoHash: string;
  readonly files: readonly FileEntry[];
  readonly packages: readonly PackageEntry[];
  readonly imports: readonly ImportEdge[];
  /** source file (repo-relative) → its colocated test files (repo-relative). */
  readonly fileToTests: Readonly<Record<string, readonly string[]>>;
  /** True when the walk hit the configured maxFiles cap (index is incomplete). */
  readonly truncated: boolean;
  /**
   * tsconfig/jsconfig path-alias status. `present` = the repo declares `compilerOptions.paths`;
   * `unresolved` = count of alias-shaped imports that could NOT be resolved to a known file. A
   * positive `unresolved` means the import graph has holes → consumers (the verification ladder)
   * must escalate to full rather than trust an impact-scoped result.
   */
  readonly aliases?: { readonly present: boolean; readonly unresolved: number };
  /** Git provenance (HEAD/branch/dirty) when the repo is a git root; undefined otherwise. */
  readonly git?: GitProvenance;
  /**
   * Wall-clock (ms epoch) the index was last written — the reference for racy-clean refresh
   * (a file whose mtime is within the racy window of this stamp is re-hashed even when its
   * size+mtime appear unchanged). METADATA, not part of the deterministic structural content.
   */
  readonly builtAtMs?: number;
}

/** Result of an incremental refresh. */
export interface RefreshResult {
  readonly added: readonly string[];
  /** Files whose content hash changed (re-parsed). */
  readonly reparsed: readonly string[];
  readonly removed: readonly string[];
  /** Count of files present and unchanged. */
  readonly unchanged: number;
  readonly data: ProjectIndexData;
  /** True when git HEAD changed since the last index → a safe FULL rebuild was performed. */
  readonly rebuilt: boolean;
  /** True when the detected HEAD differs from the persisted index's HEAD. */
  readonly headChanged: boolean;
}

/** Why a file was selected by `query`. */
export type ReasonTag =
  | "imported-by-seed"
  | "imports-seed"
  | "test-of-seed"
  | "same-package"
  | "name-match"
  | "seed";

/** What relationship to the seeds the query wants. `related` unions everything. */
export type QueryWant = "callers" | "imports" | "tests" | "related";

/** A query over a built index. Seeds are repo-relative (or absolute) file paths. */
export interface QuerySpec {
  readonly seeds: readonly string[];
  /** Default: "related". */
  readonly want?: QueryWant;
  /** Max results (default 50). */
  readonly limit?: number;
}

/** One ranked result file. */
export interface QueryResultItem {
  readonly path: string;
  readonly score: number;
  readonly reasons: readonly ReasonTag[];
}

/** The library surface. */
export interface ProjectIndexApi {
  /** Build (or rebuild) the index for `repoPath` and persist it. */
  build(repoPath: string): Promise<ProjectIndexData>;
  /** Incrementally refresh a persisted index (builds fresh if none exists). */
  refresh(repoPath: string): Promise<RefreshResult>;
  /** Load the persisted index for `repoPath`, or undefined if none. */
  load(repoPath: string): Promise<ProjectIndexData | undefined>;
  /** Query the persisted index for ranked, reason-tagged files. */
  query(repoPath: string, spec: QuerySpec): Promise<readonly QueryResultItem[]>;
}
