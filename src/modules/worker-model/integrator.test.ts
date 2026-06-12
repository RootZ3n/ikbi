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
