/**
 * Codex HIGH-2: approved corrections must actually take effect in a build.
 *   - VERIFIER: an approved expected_manifest_change correction reclassifies a flagged
 *     package.json test-script mutation (stub→real runner) as EXPECTED → verification proceeds.
 *   - REFUTER: an approved correction whose category matches a failed finding suppresses it →
 *     the build is no longer refuted.
 * In BOTH cases the correction's appliedCount increments (recordApplication is wired).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";

import { approveCorrection, createCorrection, getCorrection, listCorrections, recordApplication } from "../correction-library/store.js";
import type { CorrectionAccess } from "./correction-application.js";
import { createVerifier, type CheckResult } from "./verifier.js";
import { createRefuter } from "./refuter.js";
import type { RoleContext, RoleResult } from "./contract.js";

const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "verifier", trustTier: "verified", spawnedFrom: "parent-1" };
const WS_PATH = "/workspace/ws1";

/** A hermetic CorrectionAccess bound to a temp store dir (no env mutation, no real ~/.ikbi). */
function accessFor(dir: string): CorrectionAccess {
  return {
    listApproved: () => listCorrections({ approved: true }, dir),
    recordApplied: (id) => { recordApplication(id, dir); },
  };
}

function makeParentCtx(): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
}

function execStub(handler: (command: string, args: readonly string[]) => ExecResult) {
  const calls: ExecRequest[] = [];
  return { governedExec: { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return handler(req.command, req.args); } }, calls };
}

function verifierCtx(): RoleContext {
  const ws: WorkspaceHandle = {
    id: "ws1", targetRepo: WS_PATH, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: WS_PATH, identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  return {
    task: { taskId: "t-1", targetRepo: WS_PATH, goal: "verify" },
    role: "verifier", identity: IDENTITY, autonomy: autonomyForTier("verified"), workspace: ws, priorResults: [],
    engine: {
      invokeModel: async () => { throw new Error("verifier must never call invokeModel"); },
      neutralizeUntrusted: () => { throw new Error("verifier must not neutralize"); },
    },
  };
}

// A flagged stub→real-runner manifest mutation: "stub" is NOT one of the built-in stub patterns,
// so detectScriptMutation flags it — only an APPROVED correction can reclassify it as expected.
const stubToVitestDiff = async (): Promise<string> =>
  [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -5,7 +5,7 @@",
    '   "scripts": {',
    '-    "test": "stub",',
    '+    "test": "vitest run",',
    '     "build": "tsc"',
    "   },",
  ].join("\n");

test("HIGH-2 VERIFIER: no approved correction → a flagged stub→vitest manifest mutation stays UNTRUSTED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-corr-verify-none-"));
  try {
    const exec = execStub(() => { throw new Error("the mutated check must NOT run"); });
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: stubToVitestDiff, corrections: accessFor(dir) })(verifierCtx());
    assert.equal((result.detail as { verdict: string }).verdict, "untrusted");
    assert.equal(exec.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HIGH-2 VERIFIER: an APPROVED expected_manifest_change correction is USED → verification proceeds + appliedCount increments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-corr-verify-"));
  try {
    const corr = createCorrection(
      { category: "expected_manifest_change", finding: "stub→vitest", correction: "classify stub→vitest as EXPECTED_MANIFEST_CHANGE", regression: "assert isExpectedManifestChange holds" },
      dir,
    );
    approveCorrection(corr.id, dir);
    assert.equal(getCorrection(corr.id, dir)!.appliedCount, 0, "not yet applied");

    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: stubToVitestDiff, corrections: accessFor(dir) })(verifierCtx());

    const detail = result.detail as { verdict: string; checks: CheckResult[] };
    assert.equal(detail.verdict, "pass", "the approved correction reclassified the mutation as expected → checks ran");
    assert.equal(exec.calls.length, 2, "the checks actually executed");
    assert.equal(getCorrection(corr.id, dir)!.appliedCount, 1, "next build USED the correction → appliedCount incremented");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HIGH-2 VERIFIER: an UNAPPROVED correction is NOT used (still untrusted, appliedCount unchanged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-corr-verify-unapp-"));
  try {
    const corr = createCorrection(
      { category: "expected_manifest_change", finding: "stub→vitest", correction: "classify as expected", regression: "r" },
      dir,
    );
    // NOT approved.
    const exec = execStub(() => { throw new Error("the mutated check must NOT run"); });
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: stubToVitestDiff, corrections: accessFor(dir) })(verifierCtx());
    assert.equal((result.detail as { verdict: string }).verdict, "untrusted", "an unapproved correction never takes effect");
    assert.equal(getCorrection(corr.id, dir)!.appliedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── REFUTER ───────────────────────────────────────────────────────────────

const REFUTER_IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "refuter", trustTier: "verified", spawnedFrom: "parent-1" };

function refuterCtx(priorResults: RoleResult[]): RoleContext {
  const path = mkdtempSync(join(tmpdir(), "ikbi-corr-refuter-ws-"));
  const ws: WorkspaceHandle = {
    id: "ws1", targetRepo: path, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path, identity: REFUTER_IDENTITY, state: "allocated", createdAt: 0,
  };
  return {
    task: { taskId: "t-1", targetRepo: path, goal: "add a health endpoint" },
    role: "refuter", identity: REFUTER_IDENTITY, autonomy: autonomyForTier("verified"), workspace: ws, priorResults,
    engine: { invokeModel: async () => { throw new Error("not used"); }, neutralizeUntrusted: (c, x) => coreNeutralize(c, x) },
  };
}

const weakenedDiff = [
  "diff --git a/src/auth.test.ts b/src/auth.test.ts",
  "--- a/src/auth.test.ts",
  "+++ b/src/auth.test.ts",
  "@@ -1,2 +1,1 @@",
  "-  assert.equal(login(user), true);",
  "-  expect(token).toBe('abc');",
  "+  // removed",
  "",
].join("\n");

const refuterPriors: RoleResult[] = [
  { role: "builder", outcome: "success", detail: { filesWritten: [] } },
  { role: "verifier", outcome: "success", detail: { verdict: "pass", testEvidence: "executed" } },
];

test("HIGH-2 REFUTER: no approved correction → weakened tests REFUTE the build (baseline)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-corr-refuter-none-"));
  try {
    const role = createRefuter({ diff: async () => weakenedDiff, corrections: accessFor(dir) });
    const result = await role(refuterCtx(refuterPriors));
    assert.equal((result.detail as { refuted: boolean }).refuted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HIGH-2 REFUTER: an APPROVED test_weakening correction SUPPRESSES the finding → not refuted + appliedCount increments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-corr-refuter-"));
  try {
    const corr = createCorrection(
      { category: "test_weakening", finding: "assertions removed", correction: "operator accepts this assertion refactor", regression: "r" },
      dir,
    );
    approveCorrection(corr.id, dir);

    const role = createRefuter({ diff: async () => weakenedDiff, corrections: accessFor(dir) });
    const result = await role(refuterCtx(refuterPriors));

    assert.equal((result.detail as { refuted: boolean }).refuted, false, "the matching approved correction suppressed the refutation");
    assert.match(result.summary!, /SURVIVED/);
    assert.equal(getCorrection(corr.id, dir)!.appliedCount, 1, "the correction was applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
