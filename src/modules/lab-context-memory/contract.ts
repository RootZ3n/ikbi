/**
 * ikbi lab-context-memory — THE MODULE CONTRACT (versioned).
 *
 * This is the canonical SHARED LAB-WIDE memory substrate — NOT ikbi-only memory.
 * The lab has FOUR agents that share this memory — ikbi, the Mechanic, the Artist, Peh; any
 * agent's contributions to a project are visible to any other agent's query.
 * Example: Peh, asked about project "Luak", queries this store and surfaces what
 * the Mechanic, the Artist AND ikbi did there. ikbi is writer #1; the others wire in via the
 * (deferred) external transport.
 *
 * ikbi is WRITER #1 and the first consumer (via `projectFromReceipts`), but the
 * schema + API are CROSS-AGENT from day one: entries are project-scoped, agent-
 * attributed, kind-tagged, and queryable across agents. What is deferred is ONLY the
 * external transport/auth for non-ikbi agents to connect to the SAME store — NOT the
 * cross-agent schema, which is built now.
 *
 * REDACTION IS STRUCTURAL (safety-critical): memory OUTLIVES the ≤30-day ephemeral
 * receipts, so anything projected from a receipt outlives the layer meant to age out.
 * The projection persists ONLY structural fields (operation, outcome.status,
 * change.kind, change.target, agentId, project, timestamp, seq). It NEVER persists a
 * receipt's freeform `metadata` / `requestSummary` ("never-secrets-by-convention"
 * fields) — they are stripped structurally in the projection (no code path carries
 * them into a persisted entry).
 *
 * No frozen-core change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial lab-context-memory contract: the cross-agent MemoryEntry schema
 *           (activity | capability | pattern), record/query/byProject/byAgent and the
 *           receipt projection. Local DocumentStore; external multi-agent transport
 *           deferred, schema cross-agent by design.
 */

/** Semantic version of the lab-context-memory contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/**
 * The kind of memory:
 *  - "activity"   — what an agent DID in a project ("ikbi fixed X in Luak").
 *  - "capability" — what EXISTS ("Luak has module Y").
 *  - "pattern"    — success/failure rates per (agent, project, operation).
 */
export type MemoryKind = "activity" | "capability" | "pattern";

/**
 * One memory entry. CROSS-AGENT: `project` is the canonical grouping and `agent` is
 * WHICH agent it is attributed to — a project query returns entries across all agents.
 */
export interface MemoryEntry {
  /** Stable id derived from (project, agent, kind, key); upsert key. */
  readonly id: string;
  /** The lab project this is about (e.g. "Luak") — the cross-agent grouping. */
  readonly project: string;
  /** Which agent this memory is attributed to (ikbi, the Mechanic, the Artist, Peh, …) — an agentId. */
  readonly agent: string;
  readonly kind: MemoryKind;
  /** Stable sub-key within (project, agent, kind). */
  readonly key: string;
  /** Projected content. Structural only when projected from a receipt (see redaction). */
  readonly value: Readonly<Record<string, unknown>>;
  /** Provenance: the receipt seq this was projected from, if any. */
  readonly sourceReceiptSeq?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input to `record` — agent is taken from the identity; id/timestamps are derived. */
export interface MemoryEntryInput {
  readonly project: string;
  readonly kind: MemoryKind;
  readonly key: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly sourceReceiptSeq?: number;
}

/** A general query filter over the cross-agent store. */
export interface MemoryQuery {
  readonly project?: string;
  readonly agent?: string;
  readonly kind?: MemoryKind;
  readonly key?: string;
}

/** Failure kinds for the lab-memory writer. */
export type LabMemoryErrorKind = "disabled" | "identity" | "too_large";

/** A typed lab-memory failure (thrown only on a fail-closed write refusal). */
export class LabMemoryError extends Error {
  readonly kind: LabMemoryErrorKind;
  constructor(kind: LabMemoryErrorKind, message: string) {
    super(message);
    this.name = "LabMemoryError";
    this.kind = kind;
  }
}

/** The lab-context-memory surface (cross-agent). */
export interface LabMemory {
  /** Write/update a memory entry, attributed to identity.agentId. Upsert by id. */
  record(entry: MemoryEntryInput, identity: import("../../core/identity/index.js").ValidatedIdentity): Promise<MemoryEntry>;
  /** ikbi's first-writer path: project ephemeral receipts into durable memory (structurally redacted). */
  projectFromReceipts(opts: ProjectFromReceiptsOptions): Promise<{ projected: number }>;
  /** EVERYTHING about a project, ACROSS ALL AGENTS (the headline cross-agent query). */
  byProject(project: string): Promise<MemoryEntry[]>;
  /** What one agent did (optionally scoped to a project/kind). */
  byAgent(agent: string, opts?: { project?: string; kind?: MemoryKind }): Promise<MemoryEntry[]>;
  /** General query. */
  query(filter: MemoryQuery): Promise<MemoryEntry[]>;
  /** Fetch one entry by id. */
  get(id: string): Promise<MemoryEntry | undefined>;
}

/** Options for `projectFromReceipts`. `identity` is the agent doing the projection. */
export interface ProjectFromReceiptsOptions {
  readonly identity: import("../../core/identity/index.js").ValidatedIdentity;
  readonly project?: string;
  readonly agent?: string;
  readonly fromSeq?: number;
}
