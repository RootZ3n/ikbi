/**
 * Fix 1 (audit): the verifier must validate the TARGET repo, not an ancestor.
 *
 * Worktrees can live inside ikbi's own pnpm workspace; with cwd=worktree, `pnpm tsc`/
 * `pnpm test` walk UP and run IKBI's suite — so a target with no manifest "passes"
 * vacuously. The project-root guard (resolveChecks) makes that case RED. These tests
 * reproduce the bug (failing-first) and pin the fix.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
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
import { resolveChecks, resolveProjectRoot } from "./checks.js";
import { createVerifier } from "./verifier.js";
import type { RoleContext } from "./contract.js";

const silent = () => pino({ level: "silent" });
const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "verifier", trustTier: "verified", spawnedFrom: "parent-1" };

function makeParentCtx(): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
}

function ctxForPath(path: string): RoleContext {
  const ws: WorkspaceHandle = { id: "ws1", targetRepo: path, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path, identity: IDENTITY, state: "allocated", createdAt: 0 };
  return {
    task: { taskId: "t-1", targetRepo: path, goal: "fix add" },
    role: "verifier",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace: ws,
    priorResults: [],
    engine: { invokeModel: async () => { throw new Error("no model"); }, neutralizeUntrusted: () => { throw new Error("no"); } },
  };
}

/** A governed-exec stub that would report ALL checks GREEN (the vacuous-pass danger). */
function greenExec() {
  const calls: ExecRequest[] = [];
  const governedExec = { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }; } };
  return { governedExec, calls };
}
const cleanDiff = async () => "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// ── resolveChecks / resolveProjectRoot (pure unit) ───────────────────────────

test("resolveChecks: a worktree WITH its own package.json resolves OK at the worktree root", () => {
  const wt = tmp("ikbi-proj-ok-");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "target", scripts: { test: "node --test" } }));
  const r = resolveChecks(wt);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(resolveProjectRoot(wt), wt, "the worktree IS the project root");
});

test("resolveChecks: a worktree whose nearest manifest is an ANCESTOR is RED (wrong-repo)", () => {
  // Simulate the bug: a no-manifest target dir nested under a dir that HAS a package.json
  // (exactly like a worktree under ikbi's own workspace).
  const parent = tmp("ikbi-proj-ancestor-");
  writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "ikbi-like" }));
  const wt = join(parent, "nested", "wt");
  mkdirSync(wt, { recursive: true });
  const r = resolveChecks(wt);
  assert.equal(r.ok, false, "must NOT resolve to the ancestor's checks");
  if (!r.ok) assert.match(r.reason, /ANCESTOR|wrong repo/i);
});

test("resolveChecks: a worktree with NO project manifest anywhere is RED (no recognizable project)", () => {
  const wt = tmp("ikbi-proj-none-");
  const r = resolveChecks(wt);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /no recognizable project/i);
});

// ── verifier integration: a no-manifest target FAILS (not a vacuous pass) ─────

test("verifier on a no-manifest worktree is RED — and never runs a (vacuous) check", async () => {
  const wt = tmp("ikbi-verify-nomanifest-");
  const exec = greenExec();
  const result = await createVerifier({
    governedExec: exec.governedExec,
    parentCtx: makeParentCtx(),
    diff: cleanDiff,
    resolveChecks, // the LIVE guard (production wiring)
  })(ctxForPath(wt));

  assert.equal(result.outcome, "failure", "verifier fails closed — the work cannot be promoted");
  assert.equal(exec.calls.length, 0, "no governed check ran — never a vacuous green from an ancestor suite");
  assert.match(result.summary ?? "", /RED/);
});

test("verifier on a worktree WITH its own manifest runs the real checks (regression: the fix isn't over-broad)", async () => {
  const wt = tmp("ikbi-verify-manifest-");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "target", scripts: { test: "node --test" } }));
  const exec = greenExec();
  const result = await createVerifier({
    governedExec: exec.governedExec,
    parentCtx: makeParentCtx(),
    diff: cleanDiff,
    resolveChecks,
  })(ctxForPath(wt));

  assert.equal(result.outcome, "success", "a real target project verifies normally");
  assert.ok(exec.calls.length >= 1, "the governed checks actually ran against the target");
});
