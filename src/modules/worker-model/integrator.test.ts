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
const verifierPass: RoleResult = { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "pass", checks: [] } };

const decisionOf = (r: RoleResult): string => (r.detail as { decision: string }).decision;
const rationaleOf = (r: RoleResult): string => (r.detail as { rationale: string }).rationale;

test("all gates pass → decision promote (outcome success, approving evaluation)", async () => {
  const r = await integrator(ctxWith([builderOk, criticPass, verifierPass]));
  assert.equal(r.outcome, "success");
  assert.equal(decisionOf(r), "promote");
  assert.equal((r.detail as { evaluation: { approved: boolean } }).evaluation.approved, true);
  assert.match(rationaleOf(r), /builder wrote 2 file/);
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

test("STEP-PLANNER accumulated pass still fail-closes: a RED verifier discards even with reuseWorkspace", async () => {
  const ctx = ctxWith([{ role: "builder", outcome: "success", summary: "b", detail: { filesWritten: [], policyViolations: [] } }, criticPass, { role: "verifier", outcome: "success", summary: "v", detail: { verdict: "fail", checks: [] } }]);
  const reuse: WorkspaceHandle = {
    id: "ws-shared", targetRepo: "/repo", baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws-shared",
    path: "/repo", identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  const r = await integrator({ ...ctx, task: { ...ctx.task, reuseWorkspace: reuse } });
  assert.equal(decisionOf(r), "discard", "the builder gate relaxes on reuse, but verifier/critic gates still hold");
});

test("a required prior result absent → discard (fail-closed)", async () => {
  assert.equal(decisionOf(await integrator(ctxWith([criticPass, verifierPass]))), "discard"); // no builder
  assert.equal(decisionOf(await integrator(ctxWith([builderOk, verifierPass]))), "discard"); // no critic
  assert.equal(decisionOf(await integrator(ctxWith([builderOk, criticPass]))), "discard"); // no verifier
  assert.equal(decisionOf(await integrator(ctxWith([]))), "discard"); // nothing
});

test("non-empty rejectedToolCalls forces DISCARD even when every other gate is green (3-eyes ruling)", async () => {
  // builder success + files written + critic pass + verifier pass, but the builder
  // ATTEMPTED an out-of-policy tool call → promotion must not normalize that.
  const builderWithRejects: RoleResult = { role: "builder", outcome: "success", summary: "b", detail: { filesWritten: ["a.ts"], rejectedToolCalls: [{ tool: "write_file", error: "escape" }] } };
  const r = await integrator(ctxWith([builderWithRejects, criticPass, verifierPass]));
  assert.equal(r.outcome, "success", "the integrator still reached a decision");
  assert.equal(decisionOf(r), "discard", "a rejected tool call blocks promote");
  assert.match(rationaleOf(r), /attempted 1 out-of-policy tool call/);
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

test("PRODUCTION FIELD: non-empty policyViolations forces discard even when rejectedToolCalls is empty", async () => {
  // The filtered field is the authority: a true boundary violation blocks promote regardless of
  // the raw field. (The reverse fallback — only rejectedToolCalls present — is covered above.)
  const builderProd: RoleResult = {
    role: "builder", outcome: "success", summary: "b",
    detail: { filesWritten: ["a.ts"], policyViolations: [{ tool: "write_file", error: "escape" }], rejectedToolCalls: [] },
  };
  const r = await integrator(ctxWith([builderProd, criticPass, verifierPass]));
  assert.equal(decisionOf(r), "discard");
  assert.match(rationaleOf(r), /attempted 1 out-of-policy tool call/);
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
