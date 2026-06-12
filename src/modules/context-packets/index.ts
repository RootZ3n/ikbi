/**
 * ikbi context-packets — module entrypoint (library-only).
 *
 * @status dormant (library-only)
 *
 * Structured, byte-budgeted task packets for small/local models. Given a workspace and
 * a governed TaskContract, it produces a ContextPacket — repo map + file previews +
 * constraints + truncation report — that fits inside a model's context window. The
 * tournament uses it to brief each candidate; the patchsmith uses it to build a tool-free
 * model prompt. PURE library code: no CLI command, no server route, no singleton, no
 * active work at import. Ported from scintilla's context primitives; standalone (no
 * shared dependency with the trio).
 */

// --- repo scanner (filesystem snapshot + one-call scanRepo) ---
export {
  scanRepoContext,
  scanRepo,
  repoScannerIgnoredDirs,
  repoScannerIncludedExtensions
} from "./repoScanner.js";
export type {
  RepoPackageManager,
  RepoContextFileEntry,
  RepoContextWarning,
  RepoContextSnapshot
} from "./repoScanner.js";

// --- repo map (classified, section-bucketed structure) ---
export { buildRepoContextMap } from "./repoMap.js";
export type { RepoContextMap, RepoContextFileSummary, RepoIgnoredContextSummary } from "./repoMap.js";

// --- file previews (byte-budgeted, confinement-safe) ---
export { previewRepoFiles } from "./filePreview.js";
export type { FilePreview, FilePreviewSkip, FilePreviewResult, FilePreviewOptions } from "./filePreview.js";

// --- task contract (governed task description + validator) ---
export { validateTaskContract } from "./contract.js";
export type {
  TaskContract,
  TaskContractPromptQuality,
  TaskContractValidationError,
  TaskContractValidationResult
} from "./contract.js";

// --- the context packet itself ---
export { buildContextPacket, buildContextPacketFromContract, TaskContractPacketValidationError } from "./contextPacket.js";
export type {
  ContextPacket,
  ContextPacketTask,
  ContextPacketInput,
  ContextPacketFromContractInput,
  ContextPacketPromptQuality
} from "./contextPacket.js";

// --- consumer bridges (tournament + patchsmith) ---
export {
  buildTournamentTaskPacket,
  buildPatchsmithPrompt,
  DEFAULT_PACKET_WINDOW_FRACTION,
  DEFAULT_MAX_BYTES_PER_FILE,
  DEFAULT_MAX_TOTAL_PREVIEW_BYTES
} from "./integration.js";
export type {
  TaskPacketModelCapabilities,
  TournamentTaskInput,
  TournamentTaskPacketInput,
  PatchsmithPromptOptions
} from "./integration.js";
