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
import { workerModelConfig, DEFAULT_PREVENTED_REVIEW_THRESHOLD, DEFAULT_PREVENTED_HIGH_RISK_REVIEW_THRESHOLD } from "./config.js";

/**
 * HIGH-RISK prevented-attempt classifier: network / shell-escape / privilege / system reaches. Intent
 * still matters even when the governor blocked it — a repeated reach for the network or a root shell is
 * a red flag a single blocked `node -e` self-verify is not, so these escalate to review far faster. We
 * classify from the recorded command/error text (a prevented terminal call carries the command in
 * `path` and the binary in `error`). NOT high-risk: code-eval self-verify (node/python -e), dev/build
 * tools, benign cleanup — those are the ordinary cheap-model noise the effect-based gate stopped punishing.
 */
const HIGH_RISK_BINARIES: ReadonlySet<string> = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat",
  "bash", "sh", "zsh", "dash", "ksh", "sudo", "su", "doas", "pkexec", "chroot", "mount", "umount", "systemctl", "crontab",
]);
function isHighRiskPrevented(v: unknown): boolean {
  const o = (v ?? {}) as { path?: unknown; error?: unknown };
  // The governor names the denied binary in its error ("binary 'curl' is not on the allowlist") — the
  // precise signal. Fall back to the first token of the recorded command. Matching the BINARY (not any
  // substring of the path) avoids false-flagging a file that merely contains "sh"/"nc" in its name.
  const err = typeof o.error === "string" ? /binary ['"]?([A-Za-z0-9_.+-]+)/i.exec(o.error) : null;
  const bin = (err?.[1] ?? (typeof o.path === "string" ? o.path.trim().split(/\s+/)[0] ?? "" : "")).toLowerCase();
  return HIGH_RISK_BINARIES.has(bin);
}

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
    // REFUTER GATE (Codex HIGH-1): the refuter is the OPTIONAL adversarial gate (off by default).
    // When it ran (a refuter result is present in priorResults) and it REFUTED the build
    // (detail.refuted === true), the build is proven to be lying/broken and MUST NOT promote —
    // regardless of how the builder/critic/verifier voted. This is gated on the refuter actually
    // having run: with NO refuter result, behavior is unchanged (the default five-role pipeline).
    const refuter = ctx.priorResults.find((r) => r.role === "refuter");
    const refuterRefuted = detailOf(refuter).refuted === true;

    const builderDetail = detailOf(builder);
    const filesWritten = Array.isArray(builderDetail.filesWritten) ? builderDetail.filesWritten : [];
    // NO-CHANGE BUILD (Codex M3): the builder explicitly declared the goal already satisfied with NO
    // edits (a "verify X exists" task) and stamps doneClaim.noChangeRequired. The builder HARD-GATES
    // this — the flag is only set when run_checks was green at done — so an empty-diff promote is
    // legitimate here, not a build that simply forgot to write.
    const doneClaim = typeof builderDetail.doneClaim === "object" && builderDetail.doneClaim !== null ? (builderDetail.doneClaim as Record<string, unknown>) : {};
    const noChangeRequired = doneClaim.noChangeRequired === true;
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
    // A no-change build relaxes the filesWritten>0 gate exactly like an accumulated pass: the
    // verifier + critic gates still prove the (unchanged) state is good, and an empty diff cannot
    // forge a landed change — the workspace manager's promote downgrades a zero-diff promote to noop.
    const builderOk =
      builder?.outcome === "success" && (filesWritten.length > 0 || accumulatedPass || noChangeRequired);
    // EFFECT-BASED PROMOTE GATE: a policy violation in ikbi is a PREVENTED (governor-BLOCKED) tool call
    // — it never ran, the sandbox held, and the verifier passed on the real worktree. Judging by EFFECT
    // (the architect's directive), a prevented attempt is a recorded RISK SIGNAL, not a discard: one
    // blocked improvisation (rm / node -e / pnpm --dir — the cheap model's self-verify goofs) must NOT
    // throw away a verified-green build. Two guards remain: (1) FAIL-CLOSED on an ABSENT policy field —
    // we cannot confirm the builder even reported its tool-call status; (2) escalate to REVIEW (do not
    // silently promote) once prevented attempts reach a threshold — repetition is a stronger signal.
    // EFFECTIVE breaches that LAND (sandbox escape, egress leak, out-of-workspace write, receipt
    // tampering) are separate higher-severity alarms enforced by the orchestrator's in-run gates and are
    // never rejected tool calls, so they never reach here.
    const policyConfirmed = policyViolations !== undefined;
    // FIXER-PASS PREVENTED ATTEMPTS (A2/D3): the last-mile fixer runs a SECOND builder pass off-books
    // (no recordRole; its result never enters `results`), so its blocked out-of-policy attempts are
    // invisible to the integrator's `builder` result. The orchestrator threads them onto the builder
    // detail as `fixerPreventedViolations` (kept SEPARATE from the builder's own `policyViolations` for
    // provenance). Fold them into the RISK ACCOUNTING — the review threshold and the recorded risk
    // signal — so a fixer that racks up blocked curl/ssh attempts cannot promote unreviewed/unrecorded.
    const fixerPreventedViolations = Array.isArray(builderDetail.fixerPreventedViolations)
      ? builderDetail.fixerPreventedViolations
      : [];
    // The COMBINED prevented set that drives the threshold + telemetry. Only meaningful once the builder
    // confirmed its policy status (policyConfirmed); an absent field is fail-closed below regardless.
    const preventedForRisk = policyConfirmed ? [...policyViolations, ...fixerPreventedViolations] : [];
    const preventedCount = preventedForRisk.length;
    const highRiskCount = preventedForRisk.filter(isHighRiskPrevented).length;
    const reviewThreshold = workerModelConfig.preventedReviewThreshold ?? DEFAULT_PREVENTED_REVIEW_THRESHOLD;
    const highRiskThreshold = workerModelConfig.preventedHighRiskReviewThreshold ?? DEFAULT_PREVENTED_HIGH_RISK_REVIEW_THRESHOLD;
    // SEVERITY-TIERED: high-risk reaches (network/shell/privilege) escalate to review at a MUCH lower
    // count than ordinary blocked improvisations — intent still matters even when the governor blocked it.
    const withinRiskBudget = policyConfirmed && preventedCount < reviewThreshold && highRiskCount < highRiskThreshold;
    const policyNote = preventedCount > 0 ? `${preventedCount} PREVENTED policy attempt(s)${highRiskCount > 0 ? ` (${highRiskCount} high-risk)` : ""} recorded as risk signal (no effect)` : "no policy violations";
    const criticPass = detailOf(critic).pass === true;
    const verifierPass = detailOf(verifier).verdict === "pass";

    // REAL TEST EVIDENCE (single-run only). The verifier classifies test signal four ways
    // (executed / zero / unverified / absent — see readVerifier in orchestrator.ts, stamped onto
    // the verifier result detail). A SINGLE-RUN build that VERIFIES but ran no real tests (zero
    // tests, an unparseable green like `echo done`, or no "test" check at all) proved nothing about
    // behavior — promoting it would forge a passing test signal. So require "executed" evidence for
    // single-run promotes. ACCUMULATED builds (reuseWorkspace set) are EXEMPT: prior steps already
    // verified, and this pass may legitimately run no tests.
    //
    // FAIL-CLOSED (Codex C1): a MISSING testEvidence field is NOT exempted. The production
    // orchestrator stamps testEvidence onto every verifier result, so a real single-run promote
    // always reports "executed"; an absent field means we cannot confirm a real test signal, which
    // must block promote exactly like "zero"/"unverified" — never promote on unproven evidence.
    const testEvidence = detailOf(verifier).testEvidence;
    const testEvidenceOk = accumulatedPass || testEvidence === "executed";

    if (builderOk && policyConfirmed && withinRiskBudget && criticPass && verifierPass && testEvidenceOk && !refuterRefuted) {
      const rationale =
        accumulatedPass && filesWritten.length === 0
          ? `promote: accumulated multi-step build (this pass wrote 0 files — prior steps did the work), ${policyNote}, critic pass, verifier pass`
          : noChangeRequired && filesWritten.length === 0
            ? `promote: no-change build (goal already satisfied — builder declared noChangeRequired, 0 files written), ${policyNote}, critic pass, verifier pass`
            : `promote: builder wrote ${filesWritten.length} file(s), ${policyNote}, critic pass, verifier pass`;
      return {
        role: "integrator",
        outcome: "success", // "did its job" — the verdict is in detail.decision
        summary: rationale,
        detail: {
          decision: "promote",
          rationale,
          evaluation: { approved: true },
          // RISK SIGNAL: prevented attempts promoted-with-warning are recorded (not erased) so severity
          // can accrue over time — the receipt/audit trail carries what was blocked and that it had no effect.
          ...(preventedCount > 0
            ? { preventedViolations: preventedForRisk, ...(fixerPreventedViolations.length > 0 ? { fixerPreventedViolations } : {}), preventedCount, highRiskCount, riskSignal: { kind: "prevented_policy_attempt", effect: "none", promotionImpact: "warning", count: preventedCount, highRiskCount } }
            : {}),
        },
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
    } else if (!policyConfirmed) {
      // FAIL-CLOSED: the builder did not report its tool-call status, so we cannot confirm no EFFECTIVE
      // breach landed. (A PRESENT-but-non-empty list of PREVENTED attempts does NOT reach here — that
      // promotes-with-warning above; only an ABSENT field, or crossing the review threshold, discards.)
      failures.push("builder did not report tool-call policy status (cannot confirm clean)");
    } else if (!withinRiskBudget) {
      // REVIEW (not a quality discard): prevented attempts crossed the threshold. NAME the offending
      // call(s) so the risk is auditable from the final output without a --verbose re-run.
      const named = preventedForRisk
        .map((v) => {
          const o = (v ?? {}) as { tool?: unknown; path?: unknown; error?: unknown };
          const tool = typeof o.tool === "string" ? o.tool : "tool";
          const where = typeof o.path === "string" && o.path.length > 0 ? ` \`${o.path}\`` : "";
          return `${tool}${where}`;
        })
        .join(", ");
      const which = highRiskCount >= highRiskThreshold
        ? `${highRiskCount} HIGH-RISK (network/shell/privilege) prevented attempt(s) reached the high-risk review threshold (${highRiskThreshold})`
        : `${preventedCount} prevented policy attempt(s) reached the review threshold (${reviewThreshold})`;
      failures.push(`requires review: ${which} — held for human review, not auto-promoted: ${named}`);
    }
    if (!criticPass) failures.push(critic === undefined ? "no critic result" : "critic pass=false");
    if (!verifierPass) failures.push(verifier === undefined ? "no verifier result" : "verifier verdict=fail");
    // Only an ADDITIONAL constraint on an otherwise-passing verifier: a RED verifier already names
    // its own failure above, so the test-evidence note is redundant noise there.
    else if (!testEvidenceOk) failures.push(`single-run build has no real test evidence (test evidence "${String(testEvidence)}")`);
    // REFUTER (HIGH-1): an adversarial REFUTAL is an independent discard reason — it can hold even
    // when every other gate is green (the whole point of the adversarial gate), so it is reported
    // unconditionally (not chained behind the verifier like the test-evidence note).
    if (refuterRefuted) {
      const fb = detailOf(refuter).feedback;
      failures.push(`refuter refuted the build${typeof fb === "string" && fb.length > 0 ? ` (${fb})` : ""}`);
    }

    const rationale = `discard: ${failures.join("; ")}`;
    const overThreshold = policyConfirmed && !withinRiskBudget;
    return {
      role: "integrator",
      outcome: "success", // it reached a decision — discard is a valid, successful decision
      summary: rationale,
      detail: {
        decision: "discard",
        rationale,
        evaluation: { approved: false },
        // A review-hold is a RISK escalation, not a code-quality failure — mark it so trust/audit can
        // distinguish "too many prevented attempts, needs a human" from "the build was actually broken".
        ...(overThreshold ? { requiresReview: true, preventedCount, highRiskCount, preventedViolations: preventedForRisk, ...(fixerPreventedViolations.length > 0 ? { fixerPreventedViolations } : {}) } : {}),
      },
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
