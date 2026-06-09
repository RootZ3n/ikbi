/**
 * ikbi project-index — module entrypoint (library-only).
 *
 * A DETERMINISTIC, model-free structural index (file map + package graph + TS/JS import graph +
 * file→test mapping) with a relevance query. Foundation for retrieval, NOT symbol intelligence.
 *
 * @status dormant (library-only). DELIBERATELY UNWIRED: nothing in scout/builder/verifier/CLI/
 * server/TUI imports this, and it touches no frozen-core contract (it only reads the state-root
 * from core config and its own `IKBI_PROJECT_INDEX_*` env slice). Wiring it into retrieval is
 * future work.
 */

export {
  PROJECT_INDEX_VERSION,
  type FileEntry,
  type ImportEdge,
  type ImportKind,
  type Language,
  type PackageEntry,
  type PackageManager,
  type ProjectIndexApi,
  type ProjectIndexData,
  type QueryResultItem,
  type QuerySpec,
  type QueryWant,
  type ReasonTag,
  type RefreshResult,
} from "./contract.js";

export {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PARSE_BYTES,
  DEFAULT_SKIP_DIRS,
  loadProjectIndexConfig,
  projectIndexConfig,
  type ProjectIndexConfig,
} from "./config.js";

export {
  createProjectIndex,
  extractImportSpecifiers,
  isTestPath,
  parseGitignore,
  projectIndex,
  type ProjectIndexDeps,
} from "./implementation.js";
