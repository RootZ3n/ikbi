/**
 * UNVERIFIABLE-TARGET CLASSIFICATION (the CHECKS_UNRESOLVABLE vs CHECKS_RED distinction).
 *
 * ikbi must distinguish "checks were derived, ran, and FAILED" (CHECKS_RED — a legitimate
 * build/model failure that may escalate) from "no checks could be DERIVED for this target"
 * (CHECKS_UNRESOLVABLE / UNSUPPORTED_PROJECT — a structural fail-closed that must NOT escalate to
 * a stronger model, because a stronger model cannot conjure a missing manifest/verifier).
 *
 * These are the PURE + verifier-level pins; the orchestrator-level escalation/trust suppression is
 * pinned in orchestrator.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
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
import { classifyUnresolvableReason, resolveChecks, UNRESOLVABLE_NEXT_STEPS, unresolvableMessage } from "./checks.js";
import { createVerifier } from "./verifier.js";
import type { RoleContext } from "./contract.js";

const silent = () => pino({ level: "silent" });
const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "verifier", trustTier: "verified", spawnedFrom: "parent-1" };
const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const cleanDiff = async () => "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";

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

/** A governed-exec stub returning a fixed exit code (0 = green, non-zero = red check). */
function execWithExit(code: number) {
  const calls: ExecRequest[] = [];
  const governedExec = {
    run: async (req: ExecRequest): Promise<ExecResult> => {
      calls.push(req);
      return { executed: true, exitCode: code, stdoutTail: code === 0 ? "1 passing" : "1 failing", stderrTail: "" };
    },
  };
  return { governedExec, calls };
}

// ── PURE: classifyUnresolvableReason ─────────────────────────────────────────

test("classifyUnresolvableReason: a no-manifest reason is checks_unresolvable", () => {
  assert.equal(
    classifyUnresolvableReason("no recognizable project manifest at or above the worktree (/x) — cannot verify (RED, never a vacuous pass)"),
    "checks_unresolvable",
  );
});

test("classifyUnresolvableReason: an ancestor-manifest reason is checks_unresolvable", () => {
  assert.equal(
    classifyUnresolvableReason("the resolved project root (/p) is an ANCESTOR of the worktree (/p/wt) — checks would validate the WRONG repo (RED)"),
    "checks_unresolvable",
  );
});

test("classifyUnresolvableReason: a manifest-but-no-check-set reason is unsupported_project", () => {
  assert.equal(
    classifyUnresolvableReason("project root /x has a manifest but no recognized JS/Rust/Go/Python check set — set IKBI_CHECKS"),
    "unsupported_project",
  );
});

test("classifyUnresolvableReason: an unsupported-package-manager reason is unsupported_project", () => {
  assert.equal(
    classifyUnresolvableReason("JS/TS project at /x has only bun.lockb — bun is not a supported package manager."),
    "unsupported_project",
  );
});

test("unresolvableMessage(checks_unresolvable): WHY + not-a-model-failure + next steps", () => {
  const msg = unresolvableMessage("checks_unresolvable", "no recognizable project manifest");
  assert.match(msg, /could not verify this target because no runnable checks were found/);
  assert.match(msg, /Classification: checks_unresolvable/);
  assert.match(msg, /Detected:/);
  assert.match(msg, /no recognized project manifest or verifier/);
  assert.match(msg, /no IKBI_CHECKS override/);
  assert.match(msg, /This is not a model failure\. Escalation was suppressed because a stronger model cannot fix a missing verification contract\./);
  for (const step of UNRESOLVABLE_NEXT_STEPS) assert.ok(msg.includes(step), `message lists next step: ${step}`);
});

test("unresolvableMessage(unsupported_project): frames 'manifest found but no check set' + carries the detail", () => {
  const msg = unresolvableMessage("unsupported_project", "project root /x has a manifest but no recognized JS/Rust/Go/Python check set");
  assert.match(msg, /Classification: unsupported_project/);
  assert.match(msg, /a project manifest was found, but ikbi has no check set for this project type/);
  assert.match(msg, /details: project root \/x has a manifest but no recognized/);
  assert.match(msg, /This is not a model failure\./);
});

// ── resolveChecks classification round-trip ──────────────────────────────────

test("resolveChecks + classify: a deno.json target (manifest, no derivable checks) is unsupported_project", () => {
  const wt = tmp("ikbi-unverif-deno-");
  writeFileSync(join(wt, "deno.json"), "{}");
  const r = resolveChecks(wt);
  assert.equal(r.ok, false, "a deno.json project has no derivable ikbi check set → fail-closed");
  if (!r.ok) assert.equal(classifyUnresolvableReason(r.reason), "unsupported_project");
});

// ── verifier: CHECKS_UNRESOLVABLE verdict (distinct from CHECKS_RED) ──────────

test("verifier on a no-manifest worktree → verdict 'unresolvable' (checks_unresolvable), zero checks run", async () => {
  const wt = tmp("ikbi-unverif-nomanifest-");
  const exec = execWithExit(0); // would be GREEN if it ran — it must NOT run
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff, resolveChecks })(ctxForPath(wt));

  assert.equal(result.outcome, "failure", "fail-closed — never a vacuous pass");
  assert.equal(exec.calls.length, 0, "no governed check ran (nothing to run)");
  const d = (result.detail ?? {}) as Record<string, unknown>;
  assert.equal(d.verdict, "unresolvable", "verdict distinguishes 'could not derive checks' from 'ran and failed'");
  assert.equal(d.verificationKind, "checks_unresolvable");
  assert.ok(Array.isArray(d.nextSteps) && (d.nextSteps as unknown[]).length > 0, "carries actionable next steps");
  assert.match(result.summary ?? "", /RED/, "still flagged RED for fail-closed callers");
});

test("verifier on a deno.json worktree → verdict 'unresolvable' (unsupported_project)", async () => {
  const wt = tmp("ikbi-unverif-deno2-");
  writeFileSync(join(wt, "deno.json"), "{}");
  const exec = execWithExit(0);
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff, resolveChecks })(ctxForPath(wt));

  assert.equal(result.outcome, "failure");
  const d = (result.detail ?? {}) as Record<string, unknown>;
  assert.equal(d.verdict, "unresolvable");
  assert.equal(d.verificationKind, "unsupported_project");
});

// ── verifier: CHECKS_RED is preserved (ran and FAILED — escalation-eligible) ──

test("verifier on a manifest worktree whose checks FAIL → verdict 'fail' (CHECKS_RED), NOT unresolvable", async () => {
  const wt = tmp("ikbi-red-");
  writeFileSync(join(wt, "package.json"), JSON.stringify({ name: "target", scripts: { test: "node --test" } }));
  writeFileSync(join(wt, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const exec = execWithExit(1); // checks DID run and FAILED
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff, resolveChecks })(ctxForPath(wt));

  assert.equal(result.outcome, "failure", "red checks fail the build");
  assert.ok(exec.calls.length >= 1, "the governed checks actually RAN (this is the distinction)");
  const d = (result.detail ?? {}) as Record<string, unknown>;
  assert.equal(d.verdict, "fail", "ran-and-failed is CHECKS_RED, not unresolvable");
  assert.notEqual(d.verificationKind, "checks_unresolvable", "a red check must never be classified unresolvable");
});
