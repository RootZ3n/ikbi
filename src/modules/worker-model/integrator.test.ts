import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { integrator } from "./integrator.js";
import type { RoleContext, RoleResult } from "./contract.js";

const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "integrator", trustTier: "trusted", spawnedFrom: "parent-1" };

function ctxWith(priorResults: RoleResult[], onInvoke?: () => void): RoleContext {
  const ws: WorkspaceHandle = {
    id: "ws1", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: "/repo", identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  return {
    task: { taskId: "t-1", targetRepo: "/repo", goal: "g" },
    role: "integrator",
    identity: IDENTITY,
    autonomy: autonomyForTier("trusted"),
    workspace: ws,
    priorResults,
    engine: {
      invokeModel: async () => {
        onInvoke?.();
        throw new Error("integrator is deterministic — must not call invokeModel");
      },
      neutralizeUntrusted: () => {
        throw new Error("integrator must not neutralize");
      },
    },
  };
}

const builderOk: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts", "b.ts"], rejectedToolCalls: [] } };
const criticPass: RoleResult = { role: "critic", outcome: "success", summary: "c", detail: { pass: true, feedback: "ok" } };
// A single-run verifier pass carries testEvidence="executed": the integrator now FAILS CLOSED on a
// missing testEvidence field (Codex C1), so the production-realistic green stamps real test signal.
const verifierPass: RoleResult = { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [], testEvidence: "executed" } };

const decisionOf = (r: RoleResult): string => (r.detail as { decision: string }).decision;
const rationaleOf = (r: RoleResult): string => (r.detail as { rationale: string }).rationale;

test("all gates pass → decision promote (outcome success, approving evaluation)", async () => {
  const r = await integrator(ctxWith([builderOk, criticPass, verifierPass]));
  assert.equal(r.outcome, "success");
  assert.equal(decisionOf(r), "promote");
  assert.equal((r.detail as { evaluation: { approved: boolean } }).evaluation.approved, true);
  assert.match(rationaleOf(r), /builder wrote 2 file/);
});

test("frontier-consult synthetic builder result (policyViolations: []) PROMOTES — the recovery is reachable", async () => {
  // A frontier consult applies a diff (no tool loop), spliced as a synthetic builder result. It must
  // carry policyViolations: [] so the fail-closed policy gate reads "clean" instead of "cannot confirm"
  // and discarding every authorized recovery. This pins that the consult shape actually promotes.
  const consult: RoleResult = {
    role: "builder",
    outcome: "success",
    summary: "frontier consult patch applied",
    detail: { model: "opus-4.8", escalated: true, consult: true, filesWritten: ["a.ts"], policyViolations: [] },
  };
  const r = await integrator(ctxWith([consult, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote", "the consult recovery is not spuriously discarded by the policy gate");
});

test("critic pass=false → discard (outcome still success — the integrator decided)", async () => {
  const r = await integrator(ctxWith([builderOk, { role: "critic", outcome: "success", summary: "c", detail: { pass: false } }, verifierPass]));
  assert.equal(r.outcome, "success", "outcome=success means 'decided', not 'promote'");
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /critic pass=false/);
  assert.equal((r.detail as { evaluation: { approved: boolean } }).evaluation.approved, false);
});

test("verifier verdict=fail → discard", async () => {
  const r = await integrator(ctxWith([builderOk, criticPass, { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "fail", checks: [] } }]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /verifier/);
});

test("builder partial → discard", async () => {
  const r = await integrator(ctxWith([{ role: "builder", outcome: "partial", summary: "b", detail: { filesWritten: ["a.ts"] } }, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /builder outcome/);
});

test("builder wrote no files → discard", async () => {
  const r = await integrator(ctxWith([{ role: "builder", outcome: "success", summary: "b", detail: { filesWritten: [] } }, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /no files/);
});

test("STEP-PLANNER accumulated pass (reuseWorkspace): builder wrote 0 files this pass but verifier+critic pass → PROMOTE", async () => {
  // On a reuseWorkspace pass the work was written by prior steps; this pass's builder writing
  // nothing must NOT discard the verified accumulated build.
  const ctx = ctxWith([{ role: "builder", outcome: "success", summary: "b", detail: { filesWritten: [], policyViolations: [] } }, criticPass, verifierPass]);
  const reuse: WorkspaceHandle = {
    id: "ws-shared", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws-shared",
    path: "/repo", identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  const accumulatedCtx: RoleContext = { ...ctx, task: { ...ctx.task, reuseWorkspace: reuse } };
  const r = await integrator(accumulatedCtx);
  assert.equal(decisionOf(r), "promote", "an accumulated pass promotes on a green verifier+critic even with 0 files this pass");
  assert.equal((r.detail as { evaluation: { approved: boolean } }).evaluation.approved, true);
  assert.match(rationaleOf(r), /accumulated multi-step build/);
});

// C1 — TEST EVIDENCE GATE. The verifier stamps a 4-state testEvidence onto its result detail.
// A single-run build that VERIFIES but ran no real tests proved nothing and must NOT promote;
// an accumulated build (reuseWorkspace) is exempt because prior steps already verified.
const reuseHandle: WorkspaceHandle = {
  id: "ws-shared", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws-shared",
  path: "/repo", identity: IDENTITY, state: "allocated", createdAt: 0,
};
for (const evidence of ["zero", "unverified"] as const) {
  const verifierNoTests: RoleResult = { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [], testEvidence: evidence } };

  test(`C1: single-run verifier pass with testEvidence="${evidence}" → DISCARD (no real test signal)`, async () => {
    const r = await integrator(ctxWith([builderOk, criticPass, verifierNoTests]));
    assert.equal(decisionOf(r), "discard");
    assert.match(rationaleOf(r), /no real test evidence/);
    assert.match(rationaleOf(r), new RegExp(evidence));
  });

  test(`C1: ACCUMULATED verifier pass with testEvidence="${evidence}" → PROMOTE (prior steps verified)`, async () => {
    const ctx = ctxWith([{ role: "builder", outcome: "success", summary: "b", detail: { filesWritten: [], policyViolations: [] } }, criticPass, verifierNoTests]);
    const r = await integrator({ ...ctx, task: { ...ctx.task, reuseWorkspace: reuseHandle } });
    assert.equal(decisionOf(r), "promote", "an accumulated pass is exempt from the test-evidence gate");
  });
}

test('C1: single-run verifier pass with testEvidence="executed" → PROMOTE (real test signal)', async () => {
  const verifierExecuted: RoleResult = { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [], testEvidence: "executed" } };
  const r = await integrator(ctxWith([builderOk, criticPass, verifierExecuted]));
  assert.equal(decisionOf(r), "promote");
});

test("C1 (fail-closed): single-run verifier pass with MISSING testEvidence → DISCARD (cannot confirm a real signal)", async () => {
  // No testEvidence field at all — the integrator no longer exempts it (Codex C1). An absent field
  // is treated like "zero"/"unverified": promote requires a verified "executed" signal.
  const verifierNoEvidence: RoleResult = { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [] } };
  const r = await integrator(ctxWith([builderOk, criticPass, verifierNoEvidence]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /no real test evidence/);
});

test("STEP-PLANNER accumulated pass still fail-closes: a RED verifier discards even with reuseWorkspace", async () => {
  const ctx = ctxWith([{ role: "builder", outcome: "success", summary: "b", detail: { filesWritten: [], policyViolations: [] } }, criticPass, { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "fail", checks: [] } }]);
  const reuse: WorkspaceHandle = {
    id: "ws-shared", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws-shared",
    path: "/repo", identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  const r = await integrator({ ...ctx, task: { ...ctx.task, reuseWorkspace: reuse } });
  assert.equal(decisionOf(r), "discard", "the builder gate relaxes on reuse, but verifier/critic gates still hold");
});

test("M3: a NO-CHANGE build (doneClaim.noChangeRequired, 0 files written) → PROMOTE (not discarded)", async () => {
  // A "verify X exists" goal the builder satisfied with NO edits. The builder hard-gates the flag
  // (only set when checks were green at done), so the empty-diff promote is legitimate — the
  // filesWritten>0 gate must relax exactly like an accumulated pass.
  const builderNoChange: RoleResult = {
    role: "builder", outcome: "success", summary: "b",
    detail: { filesWritten: [], policyViolations: [], doneClaim: { noChangeRequired: true } },
  };
  const r = await integrator(ctxWith([builderNoChange, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote", "a builder-declared no-change build promotes on a green verifier+critic");
  assert.match(rationaleOf(r), /no-change build/);
});

test("M3: a zero-write build WITHOUT noChangeRequired still DISCARDS (the flag is required to relax the gate)", async () => {
  const builderForgot: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: [], policyViolations: [] } };
  const r = await integrator(ctxWith([builderForgot, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /no files/);
});

test("a required prior result absent → discard (fail-closed)", async () => {
  assert.equal(decisionOf(await integrator(ctxWith([criticPass, verifierPass]))), "discard"); // no builder
  assert.equal(decisionOf(await integrator(ctxWith([builderOk, verifierPass]))), "discard"); // no critic
  assert.equal(decisionOf(await integrator(ctxWith([builderOk, criticPass]))), "discard"); // no verifier
  assert.equal(decisionOf(await integrator(ctxWith([]))), "discard"); // nothing
});

test("EFFECT-BASED: a PREVENTED (blocked) tool call PROMOTES with a recorded risk signal, not a discard", async () => {
  // builder success + files + critic pass + verifier pass, and the builder ATTEMPTED one out-of-policy
  // tool call the governor BLOCKED (no effect, sandbox held). Judging by EFFECT, a prevented attempt is
  // an auditable RISK SIGNAL, not a discard — it must not throw away a verified-green build.
  const builderWithRejects: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], policyViolations: [{ tool: "terminal", path: 'node -e "…"', error: "code execution is not allowed" }] } };
  const r = await integrator(ctxWith([builderWithRejects, criticPass, verifierPass]));
  assert.equal(r.outcome, "success", "the integrator still reached a decision");
  assert.equal(decisionOf(r), "promote", "a prevented attempt does not block promote (judge by effect)");
  assert.match(rationaleOf(r), /1 PREVENTED policy attempt/);
  const d = r.detail as Record<string, unknown>;
  assert.equal(d.preventedCount, 1, "the risk signal is recorded, not erased");
  const risk = d.riskSignal as Record<string, unknown> | undefined;
  assert.equal(risk?.effect, "none");
  assert.equal(risk?.promotionImpact, "warning");
});

test("empty rejectedToolCalls with all gates green → promote", async () => {
  const r = await integrator(ctxWith([builderOk, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote");
  assert.match(rationaleOf(r), /no policy violations/);
});

test("FAIL-CLOSED: MISSING rejectedToolCalls (undefined) → discard even with all other gates green", async () => {
  // builder success + files + critic pass + verifier pass, but the field is absent →
  // cannot confirm the run was clean → must not promote (Hermes MEDIUM-1).
  const builderNoStatus: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"] } };
  const r = await integrator(ctxWith([builderNoStatus, criticPass, verifierPass]));
  assert.equal(r.outcome, "success");
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /cannot confirm clean/);
});

test("FAIL-CLOSED: a NON-ARRAY rejectedToolCalls → discard", async () => {
  const builderBadStatus: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], rejectedToolCalls: "nope" } };
  const r = await integrator(ctxWith([builderBadStatus, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /cannot confirm clean/);
});

test("PRODUCTION FIELD: empty policyViolations (the builder's filtered set) → promote, even with benign format errors in rejectedToolCalls", async () => {
  // The real builder emits BOTH fields: policyViolations (true boundary violations) and
  // rejectedToolCalls (raw, incl. tool-format errors). The integrator PREFERS policyViolations,
  // so a malformed-JSON tool arg the model recovered from must NOT block an otherwise-green build.
  const builderProd: RoleResult = {
    role: "builder", outcome: "success", summary: "b",
    detail: { filesWritten: ["a.ts"], policyViolations: [], rejectedToolCalls: [{ tool: "write_file", error: "malformed tool arguments (not JSON)" }] },
  };
  const r = await integrator(ctxWith([builderProd, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote");
  assert.match(rationaleOf(r), /no policy violations/);
});

test("PRODUCTION FIELD: a non-empty policyViolations promotes-with-risk-signal (prevented, no effect), not discard", async () => {
  // The filtered field is the authority. A prevented boundary attempt (blocked) is a recorded risk
  // signal — it no longer discards a verified-green build (the whack-a-mole of rm/mv/node-e ends here).
  const builderProd: RoleResult = {
    role: "builder", outcome: "success", summary: "b",
    detail: { filesWritten: ["a.ts"], policyViolations: [{ tool: "terminal", path: "rm -rf /", error: "not allowed" }], rejectedToolCalls: [] },
  };
  const r = await integrator(ctxWith([builderProd, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote");
  const d = r.detail as Record<string, unknown>;
  assert.equal(d.preventedCount, 1);
  assert.equal((d.preventedViolations as unknown[] | undefined)?.length, 1, "the blocked attempt is preserved for the audit trail");
});

test("REVIEW THRESHOLD: prevented attempts at/above the threshold escalate to review (held, not silently promoted)", async () => {
  // One blocked improvisation is a warning; MANY in one run is a stronger signal → require a human,
  // do not auto-promote. (Default threshold is 10.)
  const many = Array.from({ length: 10 }, (_, i) => ({ tool: "terminal", path: `node -e attempt ${i}`, error: "not allowed" }));
  const builderMany: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], policyViolations: many } };
  const r = await integrator(ctxWith([builderMany, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard", "over the threshold → held for review, not promoted");
  assert.match(rationaleOf(r), /requires review/);
  const d = r.detail as Record<string, unknown>;
  assert.equal(d.requiresReview, true, "marked as a review-hold, distinct from a code-quality failure");
  assert.equal(d.preventedCount, 10);
});

test("SEVERITY TIER: a few HIGH-RISK prevented reaches (curl/ssh) escalate to review far below the normal threshold", async () => {
  // Intent still matters: one blocked node -e self-verify is noise, but repeated blocked reaches for the
  // NETWORK or a root shell are a red flag even when prevented — they escalate at the high-risk threshold (2).
  const highRisk = [
    { tool: "terminal", path: "curl http://evil.example/x", error: "binary 'curl' is not on the allowlist" },
    { tool: "terminal", path: "ssh box rm -rf /", error: "binary 'ssh' is not on the allowlist" },
  ];
  const builder: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], policyViolations: highRisk } };
  const r = await integrator(ctxWith([builder, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard", "2 high-risk prevented reaches → review, though only 2 (< the normal threshold of 10)");
  assert.match(rationaleOf(r), /HIGH-RISK/);
  assert.equal((r.detail as Record<string, unknown>).highRiskCount, 2);
});

test("SEVERITY TIER: a single high-risk prevented reach still promotes (one blocked attempt is a warning, not a hold)", async () => {
  const one: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], policyViolations: [{ tool: "terminal", path: "curl http://x", error: "binary 'curl' is not on the allowlist" }] } };
  const r = await integrator(ctxWith([one, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote");
  assert.equal((r.detail as Record<string, unknown>).highRiskCount, 1);
});

test("REVIEW THRESHOLD: just UNDER the threshold still promotes (with the risk signal)", async () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ tool: "terminal", path: `node -e attempt ${i}`, error: "not allowed" }));
  const builderNine: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], policyViolations: nine } };
  const r = await integrator(ctxWith([builderNine, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote");
  assert.equal((r.detail as Record<string, unknown>).preventedCount, 9);
});

test("FIXER PREVENTED (A2/D3): off-books fixer-pass attempts fold into the risk signal on a promote", async () => {
  // The last-mile fixer runs a second builder pass off-books; the orchestrator threads its PREVENTED
  // attempts onto the builder result as a SEPARATE `fixerPreventedViolations` field. They must count
  // toward preventedCount (the risk signal), kept distinguishable from the builder's own set.
  const builder: RoleResult = {
    role: "builder", outcome: "success", summary: "b",
    detail: {
      filesWritten: ["a.ts"],
      policyViolations: [{ tool: "terminal", path: "node -e x", error: "not allowed" }],
      fixerPreventedViolations: [{ tool: "terminal", path: "node -e y", error: "not allowed" }],
    },
  };
  const r = await integrator(ctxWith([builder, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "promote", "two benign blocked attempts (< threshold) still promote");
  const d = r.detail as Record<string, unknown>;
  assert.equal(d.preventedCount, 2, "builder's own + the fixer's prevented attempt both counted");
  assert.equal((d.fixerPreventedViolations as unknown[] | undefined)?.length, 1, "fixer set preserved with provenance");
  assert.equal((d.preventedViolations as unknown[] | undefined)?.length, 2, "combined set recorded for the audit trail");
});

test("FIXER PREVENTED (A2/D3): a HIGH-RISK fixer attempt crosses the high-risk threshold and holds for review", async () => {
  // A single high-risk reach from the BUILDER promotes (warning); a second from the FIXER pushes the
  // combined high-risk count to the threshold (2) → the build can no longer promote unreviewed. This is
  // the gap A2/D3 closed: without threading the fixer attempt, this build would silently promote.
  const builder: RoleResult = {
    role: "builder", outcome: "success", summary: "b",
    detail: {
      filesWritten: ["a.ts"],
      policyViolations: [{ tool: "terminal", path: "curl http://x", error: "binary 'curl' is not on the allowlist" }],
      fixerPreventedViolations: [{ tool: "terminal", path: "ssh box", error: "binary 'ssh' is not on the allowlist" }],
    },
  };
  const r = await integrator(ctxWith([builder, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard", "combined high-risk count reaches the threshold → review-hold");
  assert.match(rationaleOf(r), /HIGH-RISK/);
  const d = r.detail as Record<string, unknown>;
  assert.equal(d.requiresReview, true);
  assert.equal(d.highRiskCount, 2, "builder's + fixer's high-risk reaches both counted");
});

test("FIXER PREVENTED (A2/D3): the fixer field alone does not confirm policy status (fail-closed still holds)", async () => {
  // fixerPreventedViolations is ADDITIVE risk evidence — it must NOT substitute for the builder's own
  // policy self-report. A builder that never reported its tool-call status still discards fail-closed.
  const builder: RoleResult = {
    role: "builder", outcome: "success", summary: "b",
    detail: { filesWritten: ["a.ts"], fixerPreventedViolations: [{ tool: "terminal", path: "node -e y", error: "not allowed" }] },
  };
  const r = await integrator(ctxWith([builder, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard", "absent builder policyViolations → cannot confirm clean → discard");
  assert.match(rationaleOf(r), /cannot confirm clean/);
});

test("MULTI-GATE: critic AND verifier both reject → rationale names BOTH failing gates", async () => {
  const criticFail: RoleResult = { role: "critic", outcome: "success", summary: "c", detail: { pass: false } };
  const verifierFail: RoleResult = { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "fail", checks: [] } };
  const r = await integrator(ctxWith([builderOk, criticFail, verifierFail]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /critic pass=false/);
  assert.match(rationaleOf(r), /verifier verdict=fail/);
});

test("MULTI-GATE: absent builder does NOT add a redundant policy reason (chain collapses to one builder reason)", async () => {
  // No builder → the empty detail bag would make policyViolations undefined; the rationale must
  // report the builder absence ALONE, not also "cannot confirm clean".
  const r = await integrator(ctxWith([criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /no builder result/);
  assert.doesNotMatch(rationaleOf(r), /cannot confirm clean/);
});

test("the integrator is deterministic — it never calls invokeModel", async () => {
  let invoked = false;
  await integrator(ctxWith([builderOk, criticPass, verifierPass], () => (invoked = true)));
  assert.equal(invoked, false);
});

test("an internal error → outcome failure (orchestrator treats as discard)", async () => {
  // Force the integrator's try/catch: priorResults is not an array, so .find throws.
  const bad = ctxWith([]);
  const broken = { ...bad, priorResults: null as unknown as RoleResult[] };
  const r = await integrator(broken);
  assert.equal(r.outcome, "failure");
  assert.equal(decisionOf(r), "discard", "fail-closed: a broken integrator still says discard");
});
