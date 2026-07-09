/**
 * ikbi memory-governor — THE MODULE CONTRACT (versioned).
 *
 * The memory governor intercepts writes to DURABLE memory surfaces and converts
 * them into PROPOSALS that require operator approval before being applied.
 *
 * Core principle: PROPOSE ONLY. No unattended durable writes to memory surfaces.
 * The model can identify what should be remembered; an operator decides whether
 * to install it.
 *
 * Governed surfaces:
 *   1. Knowledge brain (gbrain) — brain_put tool calls
 *   2. Project memory files — .ikbi/project.md, .ikbi/checks.yaml, .ikbi/ignore
 *   3. Project instruction files — CLAUDE.md, AGENTS.md, IKBI.md
 *
 * NOT governed (already safe):
 *   - lab-context-memory.record() — identity-gated, size-capped, scrubbed
 *   - Session memory — in-memory only, not persisted
 *   - Trust state — MAC-protected, engine-internal
 *   - brain_sync — already identity-gated
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog:
 *   1.0.0 — initial memory-governor contract: MemoryProposal, MemoryGovernor surface,
 *           governed paths/slug checks, proposal lifecycle (pending → approved/rejected).
 *   1.1.0 — `content` is now ALWAYS the COMPLETE resulting file for file surfaces (patch/
 *           multi_edit are resolved to the whole file at propose-time, not stored as a
 *           fragment) + optional `baseSha256` CAS guard so apply refuses a changed target
 *           instead of clobbering it (Codex C8).
 */

/** Semantic version of the memory-governor contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Governed surfaces
// ---------------------------------------------------------------------------

/** The kind of memory surface being written to. */
export type MemorySurface = "brain_page" | "project_file" | "instruction_file";

/**
 * File paths that are governed — writes to these paths are intercepted and
 * converted to proposals. Relative to the repo root.
 */
export const GOVERNED_FILE_PATHS: readonly string[] = [
  ".ikbi/project.md",
  ".ikbi/checks.yaml",
  ".ikbi/ignore",
  "IKBI.md",
  "CLAUDE.md",
  "AGENTS.md",
];

/**
 * Brain slugs are governed by default — any brain_put call is intercepted.
 * This is a prefix-based check: any slug is governed unless explicitly exempted.
 */
export const GOVERNED_BRAIN_PREFIXES: readonly string[] = [""];

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

/** The status of a memory proposal. */
export type ProposalStatus = "pending" | "approved" | "rejected";

/** A proposal to write to a governed memory surface. */
export interface MemoryProposal {
  /** Stable id derived from (surface, target). Upsert key. */
  readonly id: string;
  /** Which surface this targets. */
  readonly surface: MemorySurface;
  /** The target identifier (file path or brain slug). */
  readonly target: string;
  /**
   * The proposed content to write. For FILE surfaces this is ALWAYS the COMPLETE
   * resulting file (patch/multi_edit are resolved to the whole file at propose-time),
   * never a fragment — applying it is a full-file replace.
   */
  readonly content: string;
  /**
   * For FILE surfaces: sha256 of the target's content the proposal was computed against
   * (the CAS base; hash of "" for a new file). Apply refuses when the target's current
   * hash differs — the file changed since the proposal, so replacing it would clobber
   * unseen edits. Absent for brain-page surfaces.
   */
  readonly baseSha256?: string;
  /** Why the model wants to write this (from the model's context). */
  readonly reason?: string;
  /** Which agent proposed this (agentId). */
  readonly agentId: string;
  /** Current status. */
  readonly status: ProposalStatus;
  /** When the proposal was created. */
  readonly createdAt: number;
  /** When the proposal was last updated (status change). */
  readonly updatedAt: number;
  /** When the proposal was reviewed (approved/rejected). */
  readonly reviewedAt?: number;
  /** Who reviewed the proposal (operator agentId). */
  readonly reviewedBy?: string;
}

/** Input to create a proposal. */
export interface ProposalInput {
  readonly surface: MemorySurface;
  readonly target: string;
  readonly content: string;
  /** CAS base hash (see MemoryProposal.baseSha256). Set for file surfaces. */
  readonly baseSha256?: string;
  readonly reason?: string;
  readonly agentId: string;
}

// ---------------------------------------------------------------------------
// MemoryGovernor surface
// ---------------------------------------------------------------------------

/** The memory-governor surface — intercept, propose, review. */
export interface MemoryGovernor {
  /**
   * Intercept a write to a governed surface. Stores a proposal (upsert by
   * surface+target) and returns the proposal. The caller should return a
   * "PROPOSED:" message to the model instead of performing the write.
   */
  propose(input: ProposalInput): Promise<MemoryProposal>;

  /**
   * Approve a proposal — applies it to the target surface.
   * Returns the applied proposal, or undefined if not found.
   */
  approve(proposalId: string, reviewerId: string): Promise<MemoryProposal | undefined>;

  /**
   * Reject a proposal — discards it without applying.
   * Returns the rejected proposal, or undefined if not found.
   */
  reject(proposalId: string, reviewerId: string): Promise<MemoryProposal | undefined>;

  /**
   * Reject all pending proposals.
   * Returns the count of rejected proposals.
   */
  rejectAll(reviewerId: string): Promise<number>;

  /**
   * Get a proposal by id.
   */
  get(proposalId: string): Promise<MemoryProposal | undefined>;

  /**
   * List proposals, optionally filtered by status.
   */
  list(status?: ProposalStatus): Promise<MemoryProposal[]>;

  /**
   * Get proposal counts by status.
   */
  stats(): Promise<{ pending: number; approved: number; rejected: number; total: number }>;
}

/** Failure kinds for the memory governor. */
export type MemoryGovernorErrorKind = "disabled" | "identity" | "apply_failed";

/** A typed memory-governor failure. */
export class MemoryGovernorError extends Error {
  readonly kind: MemoryGovernorErrorKind;
  constructor(kind: MemoryGovernorErrorKind, message: string) {
    super(message);
    this.name = "MemoryGovernorError";
    this.kind = kind;
  }
}
