/**
 * ikbi v2 — THE CANONICAL SEMANTIC CRITIC AUTHORITY.
 *
 * Its question is narrow: "does THIS exact candidate materially satisfy the operator's
 * stated intent, given THIS exact deterministic VerificationRecord?" It is SEMANTIC
 * EVIDENCE — a model judgment — and nothing else. It is not verification, not recovery,
 * not repair, not disposition, not promotion, and not a second builder.
 *
 * THREE RESPONSIBILITIES, KEPT APART:
 *   verifier    — "did these exact checks pass against this exact tree?" (deterministic)
 *   CRITIC      — "does this candidate appear to satisfy intent, and what are the concrete
 *                 material defects?" (a model judgment — evidence, never proof)
 *   disposition — "given both, and policy, what happens to the candidate?" (V2-010)
 *
 * THE CONTRACT THIS FILE EXISTS TO ENFORCE — the v1 defect, closed strictly. v1's parser
 * accepted a self-contradictory critic response by DOWNGRADING it (a bare `fail` became
 * `indeterminate`). v2 does not best-effort a malformed judgment into any verdict:
 *
 *     defects_found with an empty defect list  →  HARD protocol failure, the run STOPS.
 *     satisfied with defects present            →  HARD protocol failure.
 *     a vague, category-less, empty-description defect  →  rejected.
 *     anything that is not strict JSON of the exact shape  →  rejected.
 *
 * There is no recovery here: a malformed critic response ends the run. A fallback model, a
 * re-prompt, a parser relaxation — all belong to a recovery authority that does not exist.
 *
 * WHAT THE CRITIC NEVER DOES: mutate, run a check, hold a tool, browse the live workspace,
 * or decide a disposition. It reads an IMMUTABLE review package and returns a structured
 * judgment. This file is PURE: contracts, strict parsing, identity, render, and an
 * orchestration over injected seams (the diff source, the transport, the boundary).
 */

import { estimateTokens } from "./context.js";
import { contentDigest, type V2CandidateId, type V2CriticId, type V2DecisionDigest, type V2DefectId, type V2InvocationId, type V2ReviewDigest, type V2RunId, type V2SnapshotDigest, type V2TaskId, type V2VerificationId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { CandidateRecord } from "./candidate.js";
import type { VerificationRecord, RunVerificationSummary } from "./verification.js";
import type { CandidateDiff } from "./candidate-diff.js";

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

/**
 * THE thing the critic judges, bound to its identity. Every field is something a mismatch
 * would make the judgment meaningless — a foreign run/task/candidate/tree, or a
 * verification that judged a different candidate.
 */
export interface CriticSubject {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly verificationId: V2VerificationId;
}

/** Derive the subject from the candidate and its verification. `taskId` comes from the run. */
export function criticSubjectOf(candidate: CandidateRecord, verification: VerificationRecord, taskId: V2TaskId): CriticSubject {
  return {
    runId: candidate.runId,
    taskId,
    sourceSnapshotId: candidate.sourceSnapshotId,
    candidateId: candidate.candidateId,
    candidateTreeId: candidate.tree.treeId,
    verificationId: verification.verificationId,
  };
}

/**
 * Refuse a subject that does not describe THIS candidate/verification for THIS run.
 * Returns a failure to refuse, or undefined to proceed — checked before any I/O.
 */
export function validateCriticSubject(input: {
  readonly subject: CriticSubject;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
}): RunFailure | undefined {
  const { subject, candidate, verification, runId, taskId } = input;
  const problem =
    subject.runId !== runId
      ? `the critic subject belongs to run ${subject.runId}, not ${runId}`
      : subject.taskId !== taskId
        ? `the critic subject belongs to task ${subject.taskId}, not ${taskId}`
        : candidate.runId !== runId
          ? `the candidate belongs to run ${candidate.runId}, not ${runId}`
          : subject.candidateId !== candidate.candidateId
            ? `the subject names candidate ${subject.candidateId}, not the produced ${candidate.candidateId}`
            : subject.candidateTreeId !== candidate.tree.treeId
              ? `the subject's tree ${subject.candidateTreeId} is not the candidate's tree ${candidate.tree.treeId}`
              : subject.verificationId !== verification.verificationId
                ? `the subject cites verification ${subject.verificationId}, not the produced ${verification.verificationId}`
                : verification.candidateId !== candidate.candidateId
                  ? `the verification judged candidate ${verification.candidateId}, not ${candidate.candidateId}`
                  : verification.candidateTreeId !== candidate.tree.treeId
                    ? `the verification is bound to tree ${verification.candidateTreeId}, not the candidate's ${candidate.tree.treeId}`
                    : undefined;
  if (problem === undefined) return undefined;
  return criticFailure(V2_CRITIC_FAILURE_CODES.subjectMismatch, `refusing to critique: ${problem}`, { candidateId: subject.candidateId });
}

// ---------------------------------------------------------------------------
// Material defect
// ---------------------------------------------------------------------------

/** The small, extensible defect taxonomy. A negative judgment must classify its defects. */
export const DEFECT_CATEGORIES = [
  "task_requirement_missing",
  "wrong_behavior",
  "incomplete_implementation",
  "unintended_change",
  "verification_gap",
  "unsafe_assumption",
  "regression_risk",
  "scope_violation",
] as const;

export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

export function isDefectCategory(s: string): s is DefectCategory {
  return (DEFECT_CATEGORIES as readonly string[]).includes(s);
}

/** How material a defect is. `advisory` never makes a judgment negative. */
export const DEFECT_SEVERITIES = ["advisory", "minor", "major", "blocking"] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];
export function isDefectSeverity(s: string): s is DefectSeverity {
  return (DEFECT_SEVERITIES as readonly string[]).includes(s);
}

/** A material severity is one that can make a judgment `defects_found`. */
export function isMaterialSeverity(s: DefectSeverity): boolean {
  return s === "minor" || s === "major" || s === "blocking";
}

/** The minimum description length that counts as "concrete", not a hand-wave. */
export const MIN_DEFECT_DESCRIPTION_CHARS = 12;

/**
 * V2-020/Phase 19 — EXPLICIT BOUNDS on critic text and shape.
 *
 * These are protocol limits, not style preferences. An unbounded `summary`/`description` is an
 * unbounded UNTRUSTED string that flows into receipts, repair briefs and operator output; an
 * unbounded defect list is an unbounded work item. Generous enough that no honest judgment is
 * rejected, finite enough that a runaway or hostile response is refused rather than absorbed.
 */
export const MAX_CRITIC_SUMMARY_CHARS = 4_000;
export const MAX_DEFECT_DESCRIPTION_CHARS = 4_000;
export const MAX_CRITIC_DEFECTS = 100;

/** Exactly the keys a critic judgment may carry. Anything else is refused, never ignored. */
const ALLOWED_JUDGMENT_KEYS: ReadonlySet<string> = new Set(["verdict", "summary", "defects"]);
const ALLOWED_DEFECT_KEYS: ReadonlySet<string> = new Set(["category", "severity", "description", "paths"]);

/** One concrete, structured material defect. */
export interface MaterialDefect {
  readonly defectId: V2DefectId;
  readonly category: DefectCategory;
  readonly severity: DefectSeverity;
  readonly description: string;
  /** Affected paths, when the model named any. Sorted. */
  readonly paths: readonly string[];
}

/**
 * Content address of a defect — deterministic from its semantic content, so the same
 * defect from two critic attempts has the same id (dedup, recovery, audit later). No clock.
 */
export function defectDigest(input: { category: DefectCategory; severity: DefectSeverity; description: string; paths: readonly string[] }): V2DefectId {
  return contentDigest("defect", {
    category: input.category,
    severity: input.severity,
    description: input.description.trim(),
    paths: [...input.paths].sort(),
  });
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 *   satisfied      the candidate appears to satisfy the operator's intent.
 *   defects_found  concrete material defects were found — and NAMED (≥1).
 *   indeterminate  the supplied evidence is insufficient to decide. NOT satisfied.
 */
export type CriticVerdict = "satisfied" | "defects_found" | "indeterminate";

// ---------------------------------------------------------------------------
// The strict parse
// ---------------------------------------------------------------------------

/** Why a critic response was structurally unusable. Closed set — a run-ending protocol failure. */
export type CriticProtocolProblem =
  | "not_json"
  | "missing_verdict"
  | "unknown_verdict"
  | "missing_summary"
  | "defects_not_array"
  | "malformed_defect"
  | "unknown_category"
  | "unknown_severity"
  | "empty_description"
  | "defects_found_without_material_defect"
  | "satisfied_with_material_defect"
  // V2-020/Phase 19 — permissiveness closed. A judgment that carries fields we do not understand,
  // a `paths` value that is not a list of strings, or unbounded text is not a stricter judgment;
  // it is an unvalidated one, and it is the shape a prompt-injected or drifting model produces.
  | "unknown_field"
  | "malformed_paths"
  | "summary_too_long"
  | "description_too_long"
  | "too_many_defects";

export type CriticParseResult =
  | { readonly ok: true; readonly verdict: CriticVerdict; readonly summary: string; readonly defects: readonly MaterialDefect[] }
  | { readonly ok: false; readonly problem: CriticProtocolProblem; readonly detail: string };

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Parse a critic response STRICTLY — no markdown-fence stripping, no leading/trailing prose,
 * no coercion. The response must be exactly a JSON object of the documented shape, and
 * every self-contradiction is a protocol failure, not a downgraded verdict.
 */
export function parseCriticResponse(content: string): CriticParseResult {
  const trimmed = content.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, problem: "not_json", detail: "the critic response was not a bare JSON object" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problem: "not_json", detail: "the critic response must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  // UNKNOWN FIELDS ARE REFUSED, not ignored. Silently dropping a key we do not understand means a
  // model (or an injected payload) can carry state past this authority without adjudication.
  const strayTop = Object.keys(obj).filter((k) => !ALLOWED_JUDGMENT_KEYS.has(k));
  if (strayTop.length > 0) {
    return { ok: false, problem: "unknown_field", detail: `the judgment carries unknown field(s): ${strayTop.sort().join(", ")}` };
  }

  const verdictRaw = asString(obj["verdict"]);
  if (verdictRaw === undefined) return { ok: false, problem: "missing_verdict", detail: "no string `verdict`" };
  if (verdictRaw !== "satisfied" && verdictRaw !== "defects_found" && verdictRaw !== "indeterminate") {
    return { ok: false, problem: "unknown_verdict", detail: `verdict "${verdictRaw}" is not one of satisfied/defects_found/indeterminate` };
  }
  const verdict: CriticVerdict = verdictRaw;

  const summary = asString(obj["summary"]);
  if (summary === undefined || summary.trim().length === 0) {
    return { ok: false, problem: "missing_summary", detail: "a non-empty string `summary` is required" };
  }
  if (summary.length > MAX_CRITIC_SUMMARY_CHARS) {
    return { ok: false, problem: "summary_too_long", detail: `\`summary\` exceeds ${MAX_CRITIC_SUMMARY_CHARS} characters (${summary.length})` };
  }

  const rawDefects = obj["defects"] ?? [];
  if (!Array.isArray(rawDefects)) return { ok: false, problem: "defects_not_array", detail: "`defects` must be an array" };
  if (rawDefects.length > MAX_CRITIC_DEFECTS) {
    return { ok: false, problem: "too_many_defects", detail: `\`defects\` exceeds ${MAX_CRITIC_DEFECTS} entries (${rawDefects.length})` };
  }

  const defects: MaterialDefect[] = [];
  for (const raw of rawDefects) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, problem: "malformed_defect", detail: "each defect must be an object" };
    }
    const d = raw as Record<string, unknown>;
    const strayDefect = Object.keys(d).filter((k) => !ALLOWED_DEFECT_KEYS.has(k));
    if (strayDefect.length > 0) {
      return { ok: false, problem: "unknown_field", detail: `a defect carries unknown field(s): ${strayDefect.sort().join(", ")}` };
    }
    const category = asString(d["category"]);
    if (category === undefined || !isDefectCategory(category)) {
      return { ok: false, problem: "unknown_category", detail: `defect category "${String(category)}" is not one of ${DEFECT_CATEGORIES.join(", ")}` };
    }
    const severity = asString(d["severity"]);
    if (severity === undefined || !isDefectSeverity(severity)) {
      return { ok: false, problem: "unknown_severity", detail: `defect severity "${String(severity)}" is not one of ${DEFECT_SEVERITIES.join(", ")}` };
    }
    const description = asString(d["description"]);
    if (description === undefined || description.trim().length < MIN_DEFECT_DESCRIPTION_CHARS) {
      return { ok: false, problem: "empty_description", detail: `a defect needs a concrete description of at least ${MIN_DEFECT_DESCRIPTION_CHARS} characters` };
    }
    if (description.length > MAX_DEFECT_DESCRIPTION_CHARS) {
      return { ok: false, problem: "description_too_long", detail: `a defect description exceeds ${MAX_DEFECT_DESCRIPTION_CHARS} characters (${description.length})` };
    }
    // `paths` was COERCED to [] for any non-array, and non-string members were silently dropped —
    // so a judgment that named its evidence wrongly still parsed, having quietly lost that evidence.
    // Absent is fine (no paths claimed); malformed is refused.
    const rawPaths = d["paths"];
    if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
      return { ok: false, problem: "malformed_paths", detail: "`paths` must be an array of strings when present" };
    }
    if (Array.isArray(rawPaths) && rawPaths.some((x) => typeof x !== "string")) {
      return { ok: false, problem: "malformed_paths", detail: "`paths` must contain only strings" };
    }
    const paths = Array.isArray(rawPaths) ? (rawPaths as string[]).map((x) => x.trim()).filter((x) => x.length > 0) : [];
    defects.push({
      defectId: defectDigest({ category, severity, description: description.trim(), paths: [...paths].sort() }),
      category,
      severity,
      description: description.trim(),
      paths: [...paths].sort(),
    });
  }

  // Deduplicate by content identity — a model repeating the same defect is one defect.
  const deduped = [...new Map(defects.map((d) => [d.defectId, d])).values()];
  const material = deduped.filter((d) => isMaterialSeverity(d.severity));

  // THE contradiction gates. A verdict must agree with its own evidence, or it is not a
  // verdict at all.
  if (verdict === "defects_found" && material.length === 0) {
    return {
      ok: false,
      problem: "defects_found_without_material_defect",
      detail: "verdict is defects_found but no defect of material severity (minor/major/blocking) was named",
    };
  }
  if (verdict === "satisfied" && material.length > 0) {
    return { ok: false, problem: "satisfied_with_material_defect", detail: "verdict is satisfied but material defects were listed" };
  }

  return { ok: true, verdict, summary: summary.trim(), defects: deduped };
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

/** THE immutable account of one semantic judgment, bound to exactly one candidate tree. */
export interface CriticRecord {
  readonly criticId: V2CriticId;
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly verificationId: V2VerificationId;
  readonly reviewPackageId: V2ReviewDigest;
  readonly criticDecisionId: V2DecisionDigest;
  /** PROVENANCE, not identity: the invocation event that produced this judgment. */
  readonly invocationId: V2InvocationId;
  readonly verdict: CriticVerdict;
  readonly summary: string;
  readonly defects: readonly MaterialDefect[];
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Content address of a critic judgment.
 *
 * Binds the exact candidate/tree, the verification it read, the review package it judged,
 * the critic route, the verdict, and the ordered defects. Deliberately EXCLUDES the
 * invocation id and the clock — two identical judgments over identical evidence ARE the
 * same judgment; the call that produced one is provenance. (V2-007's principle: identity
 * describes the work; the execution event is provenance.)
 */
export function criticDigest(input: {
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly verificationId: V2VerificationId;
  readonly reviewPackageId: V2ReviewDigest;
  readonly criticDecisionId: V2DecisionDigest;
  readonly verdict: CriticVerdict;
  readonly defects: readonly MaterialDefect[];
}): V2CriticId {
  return contentDigest("critic", {
    candidateId: input.candidateId,
    candidateTreeId: input.candidateTreeId,
    verificationId: input.verificationId,
    reviewPackageId: input.reviewPackageId,
    criticDecisionId: input.criticDecisionId,
    verdict: input.verdict,
    defects: [...input.defects].map((d) => ({ defectId: d.defectId, category: d.category, severity: d.severity })),
  });
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_CRITIC_FAILURE_CODES = {
  subjectMismatch: "critic.subject_mismatch",
  subjectDrift: "critic.subject_drift",
  protocolFailure: "critic.protocol_failure",
  invocationFailed: "critic.invocation_failed",
  diffFailed: "critic.candidate_diff_failed",
} as const;

/** Build a critic failure. Identities and reasons only — never raw diff/check/critic text. */
export function criticFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "verification",
    code,
    message,
    stage: "criticism",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// Receipt view
// ---------------------------------------------------------------------------

/** A receipt-safe account of a critic judgment. Ids, verdict, bounded defects — no prompt. */
export interface RunCriticSummary {
  readonly criticId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly candidateTreeId: string;
  readonly verificationId: string;
  readonly reviewPackageId: string;
  readonly criticDecisionId: string;
  readonly invocationId: string;
  readonly verdict: CriticVerdict;
  readonly summary: string;
  readonly defects: readonly {
    readonly defectId: string;
    readonly category: DefectCategory;
    readonly severity: DefectSeverity;
    readonly description: string;
    readonly paths: readonly string[];
  }[];
}

export function summarizeCritic(record: CriticRecord): RunCriticSummary {
  return {
    criticId: record.criticId,
    runId: record.runId,
    candidateId: record.candidateId,
    candidateTreeId: record.candidateTreeId,
    verificationId: record.verificationId,
    reviewPackageId: record.reviewPackageId,
    criticDecisionId: record.criticDecisionId,
    invocationId: record.invocationId,
    verdict: record.verdict,
    summary: record.summary,
    defects: record.defects.map((d) => ({ defectId: d.defectId, category: d.category, severity: d.severity, description: d.description, paths: d.paths })),
  };
}

// Re-exported for the review package + render, which live in the same authority.
export type { CriticInputPackage } from "./critic-review.js";
export { buildReviewPackage, renderCriticInput, renderCriticRepairInput, CRITIC_REPAIR_INSTRUCTION, CRITIC_SYSTEM_INSTRUCTION } from "./critic-review.js";

// Types referenced by the orchestration, re-exported so the run spine imports one module.
export type { VerificationRecord, RunVerificationSummary, CandidateDiff };

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

import { invokeAuthorized, type InvocationTransport, type ServedModelAlias, type V2InvocationRecord } from "./invocation.js";
import type { InvocationAdmission } from "./cost.js";
import type { ModelResolutionDecision } from "./resolver.js";
import type { UntrustedBoundary } from "./builder.js";
import type { CandidateDiffSource, DiffBudget } from "./candidate-diff.js";
import { buildReviewPackage, renderCriticInput, renderCriticRepairInput } from "./critic-review.js";

/** What one critic judgment produced: the record and the invocation that made it. */
export interface CriticGeneration {
  readonly record: CriticRecord;
  readonly invocation: V2InvocationRecord;
  /**
   * The ONE protocol-repair call, when the first reply failed the schema and a repair
   * produced a parseable judgement. Absent on the ordinary path. It is a real provider
   * invocation and the run ledgers and prices it exactly like the first.
   */
  readonly repairInvocation?: V2InvocationRecord;
}

export type CriticResult =
  | { readonly ok: true; readonly generation: CriticGeneration }
  | {
      readonly ok: false;
      readonly failure: RunFailure;
      readonly attemptedInvocation: boolean;
      /**
       * V2-019/HIGH-02: the InvocationId of a call that REACHED THE WIRE, so a transport failure
       * that produced no record still ESCAPES this function and stays visible in the run's
       * lifecycle ledger and the session attempt ledger. Present iff `attemptedInvocation` is
       * true. Without it a failed critic call was invisible to the invocation cap — the provider
       * had really been dialled, but nothing counted it, so recovery could exceed maxInvocations.
       */
      readonly attemptedInvocationId?: V2InvocationId;
      /** The protocol-repair call's identity, when one reached the wire and still failed. */
      readonly repairAttemptedInvocationId?: V2InvocationId;
      /** The protocol-repair call's record, when it completed but still failed to parse. */
      readonly repairInvocation?: V2InvocationRecord;
      /**
       * V2-016A/M1: the SUCCESSFUL provider invocation record, when the wire call completed but its
       * response later failed strict critic parsing. Separating INVOCATION RESULT from CRITIC PARSE
       * RESULT: the call really happened and its usage must be accounted (invocation ledger + session
       * cost), even though no CriticRecord exists. Absent when the wire call itself failed.
       */
      readonly invocation?: V2InvocationRecord;
    };

export interface JudgeCandidateInput {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly goal: string;
  readonly candidate: CandidateRecord;
  readonly verification: VerificationRecord;
  readonly verificationSummary: RunVerificationSummary;
  readonly workspacePath: string;
  readonly decision: ModelResolutionDecision;
  readonly transport: InvocationTransport;
  readonly boundary: UntrustedBoundary;
  readonly diffSource: CandidateDiffSource;
  readonly diffBudget: DiffBudget;
  readonly probeTree: (workspacePath: string) => Promise<string>;
  /**
   * V2-019/HIGH-02: the critic's InvocationId is minted by the CALLER, not hidden in here. The
   * run therefore knows the identity of the call BEFORE it is made and can account for it even
   * when this function returns a transport failure carrying no record.
   */
  readonly invocationId: V2InvocationId;
  /**
   * Identity for the ONE protocol-repair call, minted by the caller alongside the first.
   * Absent disables repair entirely — which is how every caller that has not opted in
   * keeps the previous fail-closed behaviour byte for byte.
   */
  readonly repairInvocationId?: V2InvocationId;
  /**
   * The SAME session invocation/cost authority the builder uses — never a critic-private ledger.
   * The attempt is recorded through it immediately BEFORE the wire send.
   */
  readonly admission?: InvocationAdmission;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly aliases?: readonly ServedModelAlias[];
  readonly now?: () => number;
}

/**
 * Judge one candidate. Pure orchestration over the injected seams.
 *
 * The shape is linear and every guard that trips ends the run: bind the subject, recheck
 * the tree (drift ⇒ no model call), compute the model-caused diff, assemble the immutable
 * review package, invoke the critic ONCE through the one authority, and STRICTLY parse the
 * response. A malformed or self-contradictory judgment is a protocol failure — never
 * coerced into a verdict, never retried.
 */
export async function judgeCandidate(input: JudgeCandidateInput): Promise<CriticResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const { candidate, verification, decision } = input;

  // 0. SUBJECT BINDING. A subject that does not describe this candidate/verification is
  //    refused before any I/O — judging someone else's tree is not a smaller review.
  const subject = criticSubjectOf(candidate, verification, input.taskId);
  const mismatch = validateCriticSubject({ subject, candidate, verification, runId: input.runId, taskId: input.taskId });
  if (mismatch !== undefined) return { ok: false, failure: mismatch, attemptedInvocation: false };

  // The critic must use exactly the CRITIC route — a builder decision consumed here would
  // be a role confusion. Refuse before spending anything.
  if (decision.role !== "critic") {
    return {
      ok: false,
      attemptedInvocation: false,
      failure: criticFailure(V2_CRITIC_FAILURE_CODES.subjectMismatch, `refusing to critique with a ${decision.role} route — the critic needs its own resolved decision`, { role: decision.role }),
    };
  }

  // 1. TREE RECHECK. The workspace must STILL be the candidate the verifier judged.
  //    Anything else means we would be reviewing a different tree than the deterministic
  //    record describes — so no model is asked to judge a stale subject.
  let currentTree: string;
  try {
    currentTree = await input.probeTree(input.workspacePath);
  } catch (err) {
    return {
      ok: false,
      attemptedInvocation: false,
      failure: criticFailure(V2_CRITIC_FAILURE_CODES.subjectDrift, `cannot read the candidate workspace: ${err instanceof Error ? err.message : String(err)}`, { candidateId: candidate.candidateId }),
    };
  }
  if (currentTree !== candidate.tree.treeId || currentTree !== verification.treeAfterChecks) {
    return {
      ok: false,
      attemptedInvocation: false,
      failure: criticFailure(
        V2_CRITIC_FAILURE_CODES.subjectDrift,
        `the candidate workspace drifted after verification (now ${currentTree}, candidate ${candidate.tree.treeId}, verified ${verification.treeAfterChecks}) — refusing to critique a different tree`,
        { candidateId: candidate.candidateId },
      ),
    };
  }

  // 2. MODEL-CAUSED DIFF. `startTree → candidateTree` — the operator's own work in
  //    progress is never attributed to the model.
  let diff: CandidateDiff;
  try {
    diff = await input.diffSource.diff({
      workspacePath: input.workspacePath,
      candidateId: candidate.candidateId,
      sourceSnapshotId: candidate.sourceSnapshotId,
      fromTree: candidate.tree.startTree,
      toTree: candidate.tree.treeId,
      budget: input.diffBudget,
    });
  } catch (err) {
    return {
      ok: false,
      attemptedInvocation: false,
      failure: criticFailure(V2_CRITIC_FAILURE_CODES.diffFailed, `could not compute the candidate diff: ${err instanceof Error ? err.message : String(err)}`, { candidateId: candidate.candidateId }),
    };
  }

  // 3. THE IMMUTABLE REVIEW PACKAGE + render (untrusted payloads fenced by the boundary).
  const reviewPackage = buildReviewPackage({ goal: input.goal, candidate, verification: input.verificationSummary, diff });
  const rendered = renderCriticInput(reviewPackage, input.boundary);

  // 4. INVOKE THE CRITIC — once, through the one authority, on the critic route. No tools.
  const invocationId = input.invocationId;
  // V2-019/HIGH-02: this call is ABOUT TO REACH THE WIRE. Count it against the session invocation
  // cap BEFORE the send — exactly as the builder does — so a critic call that fails in transport
  // still consumes its slot instead of being a free retry the provider nonetheless served.
  input.admission?.recordAttempt(invocationId);
  const called = await invokeAuthorized({
    runId: input.runId,
    taskId: input.taskId,
    invocationId,
    decision,
    binding: { runId: input.runId, taskId: input.taskId, resolutionDecisionId: decision.decisionId, inputId: reviewPackage.reviewPackageId },
    rendered,
    parameters: { maxOutputTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs },
    transport: input.transport,
    ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
    now,
  });
  if (!called.ok) {
    // NO FALLBACK, NO RETRY. Recovery is a later authority. The attempted identity escapes so the
    // run can ledger a real, unpriced provider call rather than losing it.
    return { ok: false, failure: called.failure, attemptedInvocation: called.attempted, ...(called.attempted ? { attemptedInvocationId: invocationId } : {}) };
  }

  // 5. STRICT PARSE. A malformed or self-contradictory judgment is a protocol failure —
  //    it ends the run. It is NEVER downgraded into a verdict (the v1 defect, closed).
  let parsed = parseCriticResponse(called.content);
  /** Set when a protocol repair actually reached the wire, so the run can ledger it. */
  let repairRecord: V2InvocationRecord | undefined;
  let repairAttemptedId: V2InvocationId | undefined;

  if (!parsed.ok && input.repairInvocationId !== undefined) {
    /*
      ONE BOUNDED PROTOCOL REPAIR.

      This is NOT a semantic retry and the distinction is the whole safety argument. It
      fires ONLY when the provider call succeeded and the reply could not be parsed as a
      judgement — never when a judgement parsed and said something unwelcome. A critic
      that lawfully returns `satisfied: false` with defects is a RESULT, and re-asking
      would be shopping for a better verdict.

      Everything about it is accounted: a fresh InvocationId, the same resolved critic
      route, cost admission before the send, the attempt counted against the session cap,
      and the record on the receipt. There is no free call and no second model.
    */
    const repairId = input.repairInvocationId;
    if (input.admission !== undefined) {
      const admitted = input.admission.admitNext({
        identity: { authorizedModelId: decision.modelId, sentProviderId: decision.providerId, sentProviderModelId: decision.providerModelId },
        estimatedInputTokens: estimateTokens(rendered.messages.map((m) => m.content).join("\n")) + estimateTokens(called.content),
        maxOutputTokens: input.maxOutputTokens,
      });
      if (!admitted.admit) {
        // The cap, not the schema, is now the operative truth — report THAT, with the
        // successful first call still on the ledger.
        return {
          ok: false,
          attemptedInvocation: true,
          attemptedInvocationId: invocationId,
          invocation: called.record,
          failure: admitted.failure,
        };
      }
    }
    input.admission?.recordAttempt(repairId);
    repairAttemptedId = repairId;
    const repairRendered = renderCriticRepairInput(reviewPackage, called.content, input.boundary);
    const repaired = await invokeAuthorized({
      runId: input.runId,
      taskId: input.taskId,
      invocationId: repairId,
      // THE SAME ROUTE. A protocol repair may not select another model or provider.
      decision,
      binding: { runId: input.runId, taskId: input.taskId, resolutionDecisionId: decision.decisionId, inputId: reviewPackage.reviewPackageId },
      rendered: repairRendered,
      parameters: { maxOutputTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs },
      transport: input.transport,
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      now,
    });
    if (repaired.ok) {
      repairRecord = repaired.record;
      // ONE attempt. If this still does not parse, the original refusal stands.
      parsed = parseCriticResponse(repaired.content);
    }
  }

  if (!parsed.ok) {
    // M1: the wire call SUCCEEDED (we have `called.record`); only the strict parse failed. Return
    // the invocation record so the run accounts the call — no protocol failure ever becomes a
    // valid critic verdict, but neither does it vanish from the invocation ledger / session cost.
    return {
      ok: false,
      attemptedInvocation: true,
      attemptedInvocationId: invocationId,
      invocation: called.record,
      ...(repairRecord !== undefined ? { repairInvocation: repairRecord } : {}),
      ...(repairAttemptedId !== undefined ? { repairAttemptedInvocationId: repairAttemptedId } : {}),
      failure: criticFailure(
        V2_CRITIC_FAILURE_CODES.protocolFailure,
        `the critic response was not a usable judgment (${parsed.problem}): ${parsed.detail}` +
          (repairAttemptedId !== undefined ? " — one protocol-repair attempt was made and also failed to parse" : ""),
        { candidateId: candidate.candidateId, problem: parsed.problem, ...(repairAttemptedId !== undefined ? { repairAttempted: true } : {}) },
      ),
    };
  }

  // 6. THE RECORD. Content-addressed over the evidence + verdict + defects; the invocation
  //    is provenance.
  const record: CriticRecord = Object.freeze({
    criticId: criticDigest({
      candidateId: candidate.candidateId,
      candidateTreeId: candidate.tree.treeId,
      verificationId: verification.verificationId,
      reviewPackageId: reviewPackage.reviewPackageId,
      criticDecisionId: decision.decisionId,
      verdict: parsed.verdict,
      defects: parsed.defects,
    }),
    runId: input.runId,
    taskId: input.taskId,
    candidateId: candidate.candidateId,
    candidateTreeId: candidate.tree.treeId,
    verificationId: verification.verificationId,
    reviewPackageId: reviewPackage.reviewPackageId,
    criticDecisionId: decision.decisionId,
    invocationId,
    verdict: parsed.verdict,
    summary: parsed.summary,
    defects: parsed.defects,
    startedAt,
    endedAt: now(),
  });

  return {
    ok: true,
    generation: {
      record,
      invocation: called.record,
      // Present only when a protocol repair actually reached the wire. The run ledgers it
      // like any other invocation, so the cost and the count stay honest.
      ...(repairRecord !== undefined ? { repairInvocation: repairRecord } : {}),
    },
  };
}
