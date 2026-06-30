/**
 * ikbi consult — contract types for the CONSULT PACKET.
 *
 * A ConsultPacket is the evidence-dense brief handed to a FRONTIER model (e.g. opus-4.8)
 * for ONE bounded, expensive decision — root-cause + plan (`advise`) or a surgical diff
 * (`patch`). It is the deliberate, explicit-only escalation path: a cheap pre-pass
 * (deterministic retrieval + scout) decides WHAT the frontier model sees; the frontier
 * model decides what it MEANS. There is no tool loop and no repo scan on the expensive
 * call — the cost is one bounded request in, one bounded plan out.
 *
 * THE LOSSY-DISTILLATION TRAP (why this type is shaped the way it is):
 *   If the cheap pre-pass already understood the subtle interaction, you would not be
 *   escalating. So the packet must be EVIDENCE-DENSE, not SUMMARY-DENSE. The discipline
 *   is enforced structurally:
 *     - `evidence.slices`        — RAW, VERBATIM code (the frontier model reads THIS).
 *     - `evidence.scoutPointers` — the cheap model's findings, kept SEPARATE and labelled
 *                                  as POINTERS INTO the slices, never as the answer.
 *     - `evidence.failingChecks` — the EXACT check output, never a paraphrase.
 *     - `evidence.triedAndFailed`— what cheap roles already tried and why it failed.
 *
 * The packet NEVER promotes. Whatever the frontier model returns re-enters through the
 * neutralization chokepoint and is gated by the normal verification ladder — a wrong
 * frontier answer still fails closed.
 *
 * @status library-only (phase 1: the packet shape + builder; no model calls).
 */

export const CONSULT_PACKET_CONTRACT_VERSION = "1.0.0";

/** What the frontier model is asked to produce. */
export type ConsultMode =
  | "advise" // root-cause + a do-X-not-Y plan; nothing touches files
  | "patch"; // a surgical diff for the identified hunks only

export type ConsultSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * One cheap-model finding, kept as a POINTER into the slices — NOT the answer.
 * Mirrors the relevant subset of worker-model's ScoutFinding so scout output drops in.
 */
export interface ScoutPointer {
  readonly title: string;
  readonly detail?: string;
  /** Repo-relative POSIX path the finding references. */
  readonly path?: string;
  /** 1-based inclusive [start, end] line range within `path`. */
  readonly lines?: readonly [number, number];
  readonly severity?: ConsultSeverity;
  readonly category?: string;
  /** 0.0–1.0 self-reported confidence. Advisory only — it does not gate anything. */
  readonly confidence?: number;
}

/** What a cheap role already tried, and why it failed — the failure trail. */
export interface ConsultAttempt {
  /** The role that made the attempt (builder | critic | fixer | verifier | …). */
  readonly role?: string;
  /** What it tried, in one or two lines. */
  readonly summary: string;
  /** Why it failed — verifier output, critic reason, error. Kept verbatim where possible. */
  readonly outcome: string;
}

/** A requested slice of a file, by 1-based inclusive line range. */
export interface ConsultSliceRequest {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** 1-based inclusive first line. */
  readonly startLine: number;
  /** 1-based inclusive last line. */
  readonly endLine: number;
}

/** A raw, verbatim code slice. The frontier model reads THIS, not a summary of it. */
export interface CodeSlice {
  readonly path: string;
  /** 1-based inclusive first line actually returned (clamped to the file). */
  readonly startLine: number;
  /** 1-based inclusive last line actually returned (clamped to the file / budget). */
  readonly endLine: number;
  /** Verbatim text of the returned lines. */
  readonly text: string;
  /** True when the slice was cut short by the per-slice byte cap or a bounded file read. */
  readonly truncated: boolean;
  /** Byte length of `text`. */
  readonly bytes: number;
}

/** A slice request that could not be honoured (confinement, missing file, budget). */
export interface CodeSliceSkip {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly reason: string;
}

export interface ConsultEvidence {
  /** EXACT failing-check output (e.g. `run_checks`), never paraphrased. Omitted if none. */
  readonly failingChecks?: string;
  /** What cheap roles already tried and why it failed. */
  readonly triedAndFailed: readonly ConsultAttempt[];
  /** RAW verbatim code the frontier model reasons over. */
  readonly slices: readonly CodeSlice[];
  /** Cheap-model findings as POINTERS into the slices — separate from, never replacing, the code. */
  readonly scoutPointers: readonly ScoutPointer[];
  /** Slice requests dropped (confinement / missing / budget), with reasons. */
  readonly skippedSlices: readonly CodeSliceSkip[];
}

export interface ConsultConstraints {
  readonly allowedFiles: readonly string[];
  readonly forbiddenFiles: readonly string[];
  /** advise → the model only recommends; patch → it may propose a diff. Never promotes either way. */
  readonly advisorAuthority: "recommend_only" | "propose_patch";
  /** The verifier — not the frontier model — determines truth. Always true. */
  readonly verifierDeterminesTruth: true;
}

export interface ConsultBudget {
  /** Per-slice text byte cap. */
  readonly maxSliceBytes: number;
  /** Total byte budget across all slices. */
  readonly maxTotalSliceBytes: number;
  /** Final packet JSON char ceiling (optional). */
  readonly maxPacketChars?: number;
}

export interface ConsultTruncation {
  readonly anySliceTruncated: boolean;
  readonly totalSliceBytes: number;
  readonly maxTotalSliceBytes: number;
  readonly maxPacketChars?: number;
  /** True when the final char-ceiling cascade had to shrink the packet. */
  readonly packetTruncated: boolean;
  /** Number of requested slices dropped ENTIRELY by the byte budget. */
  readonly droppedSlices: number;
}

/** Optional lightweight repo orientation (kept small — the slices carry the weight). */
export interface ConsultRepoSummary {
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

export interface ConsultPacket {
  readonly contractVersion: string;
  readonly generatedAt: string;
  readonly repoRoot: string;
  readonly mode: ConsultMode;
  /** The specific decision the frontier model must make. */
  readonly question: string;
  /** The originating build/repair goal, if this consult arose from one. */
  readonly goal?: string;
  readonly repoSummary?: ConsultRepoSummary;
  readonly evidence: ConsultEvidence;
  readonly constraints: ConsultConstraints;
  readonly budget: ConsultBudget;
  readonly truncation: ConsultTruncation;
  readonly warnings: readonly string[];
}

export interface ConsultPacketInput {
  readonly repoRoot: string;
  readonly mode: ConsultMode;
  readonly question: string;
  readonly goal?: string;
  /** Slice requests — produced by retrieval + scout in the orchestrator (phase 3). */
  readonly sliceRequests: readonly ConsultSliceRequest[];
  readonly scoutPointers?: readonly ScoutPointer[];
  readonly failingChecks?: string;
  readonly triedAndFailed?: readonly ConsultAttempt[];
  readonly allowedFiles?: readonly string[];
  readonly forbiddenFiles?: readonly string[];
  readonly repoSummary?: ConsultRepoSummary;
  readonly budget?: {
    readonly maxSliceBytes?: number;
    readonly maxTotalSliceBytes?: number;
    readonly maxPacketChars?: number;
  };
}
