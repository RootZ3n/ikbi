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
 *   - no policy violations:  the builder's policy-status field is a PRESENT, EMPTY
 *                            array. We PREFER detail.policyViolations (the builder's
 *                            already-filtered set of true boundary violations) and
 *                            fall back to detail.rejectedToolCalls (the raw set,
 *                            including benign tool-format errors) only when the
 *                            filtered field is absent — so an older/partial builder
 *                            that reports only the raw field still fails closed. A
 *                            non-empty array (an attempted out-of-policy tool call)
 *                            OR a missing/non-array field (cannot confirm clean)
 *                            BOTH force discard — fail-closed, matching the egress
 *                            default-deny posture;
 *   - critic approved:       detail.pass === true;
 *   - verifier passed:       detail.verdict === "pass";
 *   - real test evidence:    SINGLE-RUN builds require detail.testEvidence === "executed" (a verified
 *                            green with no real test signal proves nothing). ACCUMULATED builds
 *                            (reuseWorkspace set) are exempt — prior steps already verified.
 *
 * On discard the rationale names EVERY failing gate (not just the first), so the
 * receipt trail tells an operator/agent the full reason a build did not land.
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
    // FAIL-CLOSED: a missing/non-array policyViolations means "cannot confirm clean"
    // → undefined (never []), so the gate below does NOT pass on an absent field.
    const policyViolations = Array.isArray(builderDetail.policyViolations)
      ? builderDetail.policyViolations
      : Array.isArray(builderDetail.rejectedToolCalls)
        ? builderDetail.rejectedToolCalls
        : undefined;

    // STEP-PLANNER ACCUMULATED PASS: when the task REUSES a workspace, the work was written by
    // PRIOR steps in that shared workspace, so THIS pass's builder may legitimately write nothing
    // ("everything is already done — just verify + promote"). Requiring filesWritten>0 here would
    // DISCARD a fully-verified, critic-approved accumulated build (and because every role succeeded,
    // the orchestrator's retention guard does not even fire — the committed work is lost). On a reuse
    // pass, accept a SUCCESSFUL builder as having produced work; the verifier + critic gates still
    // prove the accumulated state is good.
    //
    // DEFENSE-IN-DEPTH against a no-op accumulated chain (every step writes nothing → empty diff):
    // promoting here is SAFE because the empty diff is caught downstream and does NOT land. The
    // workspace manager's promote compares scratchHead to targetHead and, when they are equal
    // (nothing committed beyond base), returns { promoted: false, strategy: "noop", reason: "no
    // changes to promote" } (src/core/workspace/manager.ts). The orchestrator then downgrades that
    // run to "partial" — nothing is integrated. So an empty accumulated build cannot forge a landed
    // change even though the integrator decided "promote". (Confirmed by a workspace-manager test of
    // the empty-diff noop path.) Single-pass runs (no reuseWorkspace) keep the strict filesWritten>0
    // gate unchanged.
    const accumulatedPass = ctx.task.reuseWorkspace !== undefined;
    const builderOk =
      builder?.outcome === "success" && (filesWritten.length > 0 || accumulatedPass);
    const noPolicyViolations = policyViolations !== undefined && policyViolations.length === 0;
    const criticPass = detailOf(critic).pass === true;
    const verifierPass = detailOf(verifier).verdict === "pass";

    // REAL TEST EVIDENCE (single-run only). The verifier classifies test signal four ways
    // (executed / zero / unverified / absent — see readVerifier in orchestrator.ts, stamped onto
    // the verifier result detail). A SINGLE-RUN build that VERIFIES but ran no real tests (zero
    // tests, an unparseable green like `echo done`, or no "test" check at all) proved nothing about
    // behavior — promoting it would forge a passing test signal. So require "executed" evidence for
    // single-run promotes. ACCUMULATED builds (reuseWorkspace set) are EXEMPT: prior steps already
    // verified, and this pass may legitimately run no tests. A MISSING field (a legacy verifier
    // result that never reported evidence) is NOT blocked — backward-compatible; the production
    // orchestrator stamps testEvidence onto every verifier result, so real runs always report it.
    const testEvidence = detailOf(verifier).testEvidence;
    const testEvidenceOk = accumulatedPass || testEvidence === undefined || testEvidence === "executed";

    if (builderOk && noPolicyViolations && criticPass && verifierPass && testEvidenceOk) {
      const rationale =
        accumulatedPass && filesWritten.length === 0
          ? "promote: accumulated multi-step build (this pass wrote 0 files — prior steps did the work), no policy violations, critic pass, verifier pass"
          : `promote: builder wrote ${filesWritten.length} file(s), no policy violations, critic pass, verifier pass`;
      return {
        role: "integrator",
        outcome: "success", // "did its job" — the verdict is in detail.decision
        summary: rationale,
        detail: { decision: "promote", rationale, evaluation: { approved: true } },
      };
    }

    // List EVERY failing gate (not just the first) so the receipt trail records the full
    // reason a build did not land — when both the critic AND the verifier reject, an
    // operator/agent debugging the discard sees both, not just whichever was checked first.
    // A rejected tool call is an ATTEMPTED policy-boundary violation (3-eyes ruling):
    // promotion must not normalize a run that tried an out-of-policy tool action, even
    // though confinement held and the later checks passed.
    const failures: string[] = [];
    // Builder + policy form one chain: the policy field is only meaningful once the builder
    // produced work, so an absent builder reports the builder reason ALONE (no redundant
    // "cannot confirm clean" noise from the empty detail bag).
    if (!builderOk) {
      if (builder === undefined) failures.push("no builder result");
      else if (builder.outcome !== "success") failures.push(`builder outcome "${builder.outcome}"`);
      else failures.push("builder wrote no files");
    } else if (!noPolicyViolations) {
      if (policyViolations === undefined) failures.push("builder did not report tool-call policy status (cannot confirm clean)");
      else failures.push(`builder attempted ${policyViolations.length} out-of-policy tool call(s)`);
    }
    if (!criticPass) failures.push(critic === undefined ? "no critic result" : "critic pass=false");
    if (!verifierPass) failures.push(verifier === undefined ? "no verifier result" : "verifier verdict=fail");
    // Only an ADDITIONAL constraint on an otherwise-passing verifier: a RED verifier already names
    // its own failure above, so the test-evidence note is redundant noise there.
    else if (!testEvidenceOk) failures.push(`single-run build has no real test evidence (test evidence "${String(testEvidence)}")`);

    const rationale = `discard: ${failures.join("; ")}`;
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
