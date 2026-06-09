/**
 * ikbi project-retrieval — module entrypoint (library-only).
 *
 * Deterministic, model-free relevance retrieval over project-index. Scout consumes it ONLY behind
 * IKBI_RETRIEVAL=index; nothing else wires it. No frozen-core contract is touched.
 */

export {
  type ProjectRetrievalApi,
  type RetrievalReason,
  type RetrievalRequest,
  type RetrievalResult,
  type SelectedFile,
} from "./contract.js";

export {
  DEFAULT_BUDGET_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PER_TERM,
  DEFAULT_PER_FILE_CAP_BYTES,
  loadProjectRetrievalConfig,
  projectRetrievalConfig,
  STOPWORDS,
  type ProjectRetrievalConfig,
} from "./config.js";

export { createProjectRetrieval, goalTokens, projectRetrieval, type ProjectRetrievalDeps } from "./implementation.js";
