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
  | "satisfied_with_material_defect";

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

  const rawDefects = obj["defects"] ?? [];
  if (!Array.isArray(rawDefects)) return { ok: false, problem: "defects_not_array", detail: "`defects` must be an array" };

  const defects: MaterialDefect[] = [];
  for (const raw of rawDefects) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, problem: "malformed_defect", detail: "each defect must be an object" };
    }
    const d = raw as Record<string, unknown>;
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
    const paths = Array.isArray(d["paths"]) ? d["paths"].filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter((p) => p.length > 0) : [];
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
export { buildReviewPackage, renderCriticInput, CRITIC_SYSTEM_INSTRUCTION } from "./critic-review.js";

// Types referenced by the orchestration, re-exported so the run spine imports one module.
export type { VerificationRecord, RunVerificationSummary, CandidateDiff };

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

import { invokeAuthorized, type InvocationTransport, type ServedModelAlias, type V2InvocationRecord } from "./invocation.js";
import type { ModelResolutionDecision } from "./resolver.js";
import type { UntrustedBoundary } from "./builder.js";
import type { CandidateDiffSource, DiffBudget } from "./candidate-diff.js";
import { buildReviewPackage, renderCriticInput } from "./critic-review.js";

/** What one critic judgment produced: the record and the invocation that made it. */
export interface CriticGeneration {
  readonly record: CriticRecord;
  readonly invocation: V2InvocationRecord;
}

export type CriticResult =
  | { readonly ok: true; readonly generation: CriticGeneration }
  | {
      readonly ok: false;
      readonly failure: RunFailure;
      readonly attemptedInvocation: boolean;
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
  readonly mintInvocationId: () => V2InvocationId;
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
  const invocationId = input.mintInvocationId();
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
    // NO FALLBACK, NO RETRY. Recovery is a later authority.
    return { ok: false, failure: called.failure, attemptedInvocation: called.attempted };
  }

  // 5. STRICT PARSE. A malformed or self-contradictory judgment is a protocol failure —
  //    it ends the run. It is NEVER downgraded into a verdict (the v1 defect, closed).
  const parsed = parseCriticResponse(called.content);
  if (!parsed.ok) {
    // M1: the wire call SUCCEEDED (we have `called.record`); only the strict parse failed. Return
    // the invocation record so the run accounts the call — no protocol failure ever becomes a
    // valid critic verdict, but neither does it vanish from the invocation ledger / session cost.
    return {
      ok: false,
      attemptedInvocation: true,
      invocation: called.record,
      failure: criticFailure(
        V2_CRITIC_FAILURE_CODES.protocolFailure,
        `the critic response was not a usable judgment (${parsed.problem}): ${parsed.detail}`,
        { candidateId: candidate.candidateId, problem: parsed.problem },
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

  return { ok: true, generation: { record, invocation: called.record } };
}
