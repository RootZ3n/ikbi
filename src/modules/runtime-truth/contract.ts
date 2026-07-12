/**
 * ikbi runtime-truth — PRODUCTION EVIDENCE CONTRACT (Phase 5).
 *
 * This is the EVIDENCE layer (distinct from `runtime-truth-shadow`, which is advisory cognition
 * telemetry). It injects trustworthy, bounded, provenance-bearing runtime evidence into the actual
 * builder/critic model context so a role can deliberate against externally-grounded facts about the
 * current execution — NOT model inference, NOT user instructions, NOT historical memory.
 *
 * Runtime truth here is: externally grounded, source-attributed, freshness-bounded, scoped to the
 * correct task/repo/workspace/candidate, and safe to omit when unavailable. A model-generated summary
 * is NOT runtime truth unless its provenance explicitly marks it a summary of verified evidence.
 *
 * STANDALONE: ikbi imports no external lab package. The real reader is an operator-provided adapter
 * resolved at runtime (an injected dep, or a dynamic import of a configured module) — see config.ts.
 */

export const CONTRACT_VERSION = "1.0.0";

/** The class of the evidence's origin — drives priority + truthful receipts. */
export type EvidenceProvenanceKind =
  | "verifier" // a deterministic verifier check result for this candidate
  | "receipt" // a durable receipt from a prior verified step of this task
  | "governed-exec" // a governed command execution result
  | "workspace" // the current workspace/tree identity
  | "repo" // current repository facts (branch, head, manifests)
  | "constraint" // an authoritative task constraint accepted for this task
  | "dependency" // dependency/environment/tool-availability facts
  | "other";

/** A single, provenance-bearing runtime-evidence item, scoped to where it is valid. */
export interface RuntimeEvidence {
  /** Stable/content id (used for dedup + receipts). */
  readonly id: string;
  /** The concise externally-grounded claim (e.g. "pnpm test: 42 passed, 0 failed"). */
  readonly claim: string;
  /** Human-readable source label (e.g. "verifier:test", "receipt:worker.run.summary"). */
  readonly source: string;
  readonly provenance: { readonly kind: EvidenceProvenanceKind; readonly ref?: string };
  /** The scope this evidence is valid for — enforced by the filter (no cross-scope leakage). */
  readonly scope: EvidenceItemScope;
  /** Wall-clock ms the evidence was observed (freshness). */
  readonly observedAt: number;
}

/** The scope an evidence ITEM claims to belong to. Any populated field must match the request. */
export interface EvidenceItemScope {
  readonly taskId: string;
  readonly repo: string;
  readonly attemptId?: string;
  readonly workspaceId?: string;
  readonly candidateId?: string;
  readonly verifiedTree?: string;
  readonly baseTree?: string;
  readonly strategy?: string;
}

/** The scope of a role's evidence REQUEST — bounds what evidence may be returned + injected. */
export interface EvidenceRequestScope {
  readonly taskId: string;
  readonly repo: string;
  readonly role: string;
  readonly attemptId?: string;
  readonly workspaceId?: string;
  readonly candidateId?: string;
  readonly verifiedTree?: string;
  readonly baseTree?: string;
  readonly strategy?: string;
  /** Current wall-clock ms (freshness reference — injected for determinism). */
  readonly now: number;
  /** Evidence older than this window (ms) is omitted as expired. */
  readonly freshnessWindowMs: number;
}

/** The operator-provided reader. Returns candidate evidence for a request scope; MUST fail closed. */
export interface RuntimeTruthEvidenceReader {
  /** A stable id of the reader (module path / adapter name) — recorded truthfully in receipts. */
  readonly id: string;
  readEvidence(scope: EvidenceRequestScope): Promise<readonly RuntimeEvidence[]> | readonly RuntimeEvidence[];
}

/** Context bounds — protect cheap-tier economics + prompt size. Whole items drop; never truncate one. */
export interface EvidenceLimits {
  readonly maxItems: number;
  readonly maxTotalBytes: number;
  readonly maxItemBytes: number;
}

/** Why an item was omitted (truthful receipts + tests). */
export type OmitReason =
  | "malformed"
  | "missing-provenance"
  | "wrong-task"
  | "wrong-repo"
  | "wrong-attempt"
  | "wrong-candidate"
  | "stale-tree"
  | "expired"
  | "duplicate"
  | "too-large"
  | "bounded-out";

/** The outcome of a scoped request → filter → bound cycle (for the role context + the receipt). */
export interface RuntimeTruthResult {
  readonly enabled: boolean;
  readonly readerId?: string;
  readonly scope: EvidenceRequestScope;
  readonly kept: readonly RuntimeEvidence[];
  readonly omitted: readonly { readonly id: string; readonly reason: OmitReason }[];
  readonly truncated: boolean;
  /** Set true only when the kept evidence was actually placed into the model request. */
  injected: boolean;
  /** A clear operational status when the reader was unavailable / failed (advisory). */
  readonly error?: string;
}
