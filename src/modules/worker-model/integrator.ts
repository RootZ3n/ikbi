/**
 * ikbi worker-model — INTEGRATOR role (Pass C: the promote DECISION).
 *
 * Runs last. Weighs scout/builder/critic/verifier results and returns a
 * fail-closed promote/discard DECISION. It does NOT call workspace.promote/discard
 * — the lifecycle stays orchestrator-owned; the integrator only DECIDES, and the
 * orchestrator enacts (see orchestrator.ts decision wiring).
 *
 * SUBTLE — outcome vs decision (mirrors critic's pass-vs-outcome): the integrator
 * returning `outcome: "success"` means "the integrator DID ITS JOB (reached a
 * decision)", NOT "promote". The actual promote/discard verdict lives in
 * `detail.decision`. `outcome: "failure"` is reserved for the integrator's OWN
 * infrastructure error — which the orchestrator treats as discard (fail-closed).
 *
 * Decision (promote ONLY if ALL gates hold; otherwise discard — fail-closed):
 *   - builder produced work: outcome "success" AND detail.filesWritten non-empty;
 *   - no policy violations:  detail.rejectedToolCalls is a PRESENT, EMPTY array. A
 *                            non-empty array (an attempted out-of-policy tool call)
 *                            OR a missing/non-array field (cannot confirm clean)
 *                            BOTH force discard — fail-closed, matching the egress
 *                            default-deny posture;
 *   - critic approved:       detail.pass === true;
 *   - verifier passed:       detail.verdict === "pass".
 */

import type { RoleFn, RoleResult } from "./contract.js";

/** Safe accessor for a role result's open detail bag. */
function detailOf(result: RoleResult | undefined): Record<string, unknown> {
  const d = result?.detail;
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}

export const integrator: RoleFn = async (ctx) => {
  try {
    const builder = ctx.priorResults.find((r) => r.role === "builder");
    const critic = ctx.priorResults.find((r) => r.role === "critic");
    const verifier = ctx.priorResults.find((r) => r.role === "verifier");

    const builderDetail = detailOf(builder);
    const filesWritten = Array.isArray(builderDetail.filesWritten) ? builderDetail.filesWritten : [];
    // FAIL-CLOSED: a missing/non-array rejectedToolCalls means "cannot confirm clean"
    // → undefined (never []), so the gate below does NOT pass on an absent field.
    const rejected = Array.isArray(builderDetail.rejectedToolCalls) ? builderDetail.rejectedToolCalls : undefined;

    const builderOk = builder?.outcome === "success" && filesWritten.length > 0;
    const noRejectedToolCalls = rejected !== undefined && rejected.length === 0;
    const criticPass = detailOf(critic).pass === true;
    const verifierPass = detailOf(verifier).verdict === "pass";

    if (builderOk && noRejectedToolCalls && criticPass && verifierPass) {
      const rationale = `promote: builder wrote ${filesWritten.length} file(s), no rejected tool calls, critic pass, verifier pass`;
      return {
        role: "integrator",
        outcome: "success", // "did its job" — the verdict is in detail.decision
        summary: rationale,
        detail: { decision: "promote", rationale, evaluation: { approved: true } },
      };
    }

    // Identify the FIRST failing gate for a human-readable rationale (fail-closed).
    // A rejected tool call is an ATTEMPTED policy-boundary violation (3-eyes ruling):
    // promotion must not normalize a run that tried an out-of-policy tool action,
    // even though confinement held and the later checks passed.
    let why: string;
    if (builder === undefined) why = "no builder result";
    else if (builder.outcome !== "success") why = `builder outcome "${builder.outcome}"`;
    else if (filesWritten.length === 0) why = "builder wrote no files";
    else if (rejected === undefined) why = "builder did not report tool-call policy status (cannot confirm clean)";
    else if (rejected.length > 0) why = `builder attempted ${rejected.length} out-of-policy tool call(s)`;
    else if (critic === undefined) why = "no critic result";
    else if (!criticPass) why = "critic pass=false";
    else if (verifier === undefined) why = "no verifier result";
    else why = "verifier verdict=fail";

    const rationale = `discard: ${why}`;
    return {
      role: "integrator",
      outcome: "success", // it reached a decision — discard is a valid, successful decision
      summary: rationale,
      detail: { decision: "discard", rationale, evaluation: { approved: false } },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      role: "integrator",
      outcome: "failure", // the integrator's OWN failure → orchestrator discards (fail-closed)
      summary: `integrator failed: ${msg}`,
      detail: { decision: "discard", rationale: `integrator error: ${msg}`, evaluation: { approved: false } },
    };
  }
};
