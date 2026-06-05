import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createVerifier, detectScriptMutation, type CheckResult } from "./verifier.js";
import type { RoleContext } from "./contract.js";

const silent = () => pino({ level: "silent" });
const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "verifier", trustTier: "verified", spawnedFrom: "parent-1" };
const WS_PATH = "/workspace/ws1";

/** A real validated OperationContext (governed-exec is faked, but the wiring is real). */
function makeParentCtx(): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
}

function makeCtx() {
  let invokeCalls = 0;
  const ws: WorkspaceHandle = {
    id: "ws1", targetRepo: WS_PATH, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: WS_PATH, identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  const ctx: RoleContext = {
    task: { taskId: "t-1", targetRepo: WS_PATH, goal: "verify" },
    role: "verifier",
    identity: IDENTITY,
    autonomy: autonomyForTier("verified"),
    workspace: ws,
    priorResults: [],
    engine: {
      invokeModel: async () => { invokeCalls += 1; throw new Error("verifier must never call invokeModel"); },
      neutralizeUntrusted: () => { throw new Error("verifier must not neutralize"); },
    },
  };
  return { ctx, invokeCalls: () => invokeCalls };
}

/** A fake governed executor recording every run() and answering per the supplied handler. */
function execStub(handler: (command: string, args: readonly string[]) => ExecResult) {
  const calls: ExecRequest[] = [];
  const governedExec = {
    run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return handler(req.command, req.args); },
  };
  return { governedExec, calls };
}

/** No diff source declared as "no mutation" by default (clean diff). */
const cleanDiff = async () => "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

// ── LAYER 1: GOVERNED EXECUTION (not raw spawnSync) ──────────────────────────

test("LAYER 1: the verifier routes EVERY check through governed-exec (command/args/cwd), maps results", async () => {
  const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }));
  const { ctx, invokeCalls } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);

  assert.equal(result.outcome, "success");
  assert.equal(exec.calls.length, 2, "governed-exec ran once per fixed check (NOT raw spawnSync)");
  assert.deepEqual(exec.calls.map((c) => c.command), ["pnpm", "pnpm"]);
  assert.deepEqual(exec.calls[0]?.args, ["tsc", "--noEmit"]);
  assert.deepEqual(exec.calls[1]?.args, ["test"]);
  for (const c of exec.calls) assert.equal(c.cwd, WS_PATH, "each check runs in the workspace path");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "pass");
  assert.equal(detail.checks.length, 2);
  assert.equal(invokeCalls(), 0, "verifier is deterministic — never calls invokeModel");
});

test("LAYER 1: a failing governed check (non-zero exit) → outcome:failure", async () => {
  const exec = execStub((_cmd, args) => args.includes("test") ? { executed: true, exitCode: 1, stdoutTail: "1 failing" } : { executed: true, exitCode: 0 });
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);

  assert.equal(result.outcome, "failure");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "fail");
  assert.ok(detail.checks.find((c) => c.exitCode !== 0 && /test/.test(c.command)), "the failed test check is recorded");
});

// ── LAYER 1: DENIED → FAIL-CLOSED (never a silent pass) ──────────────────────

test("LAYER 1 denied: a non-allowlisted / gate-denied check FAILS CLOSED (not a pass, not a crash)", async () => {
  const exec = execStub((cmd) => ({ executed: false, denied: true, reason: `binary "${cmd}" is not on the allowlist` }));
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);

  assert.equal(result.outcome, "failure", "a denied governed check is fail-closed, NOT a silent pass");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "fail");
  for (const c of detail.checks) {
    assert.notEqual(c.exitCode, 0, "a denied check is non-zero");
    assert.match(c.outputTail, /DENIED/);
    assert.match(c.outputTail, /ALLOWLIST/, "the operator opt-in is surfaced");
  }
});

// ── LAYER 1: DRY-RUN → explicit verdict (not a false pass) ───────────────────

test("LAYER 1 dry-run: governed-exec executes nothing → a dry-run verdict, NOT a pass", async () => {
  const exec = execStub((cmd) => ({ executed: false, reason: `dry-run: would exec ${cmd}` }));
  const { ctx } = makeCtx();
  const dryCtx = beginOperation(makeParentCtx().identity, { requestId: "req-1", dryRun: true });
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: dryCtx, diff: cleanDiff })(ctx);

  assert.notEqual(result.outcome, "success", "a dry-run that executed nothing is NOT a pass");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "dry-run", "the dry-run case is explicitly handled");
});

// ── LAYER 2: SCRIPT-MUTATION REJECTED (the headline security test) ───────────

test("LAYER 2 ATTACK: a builder that rewrote package.json's test script → verification UNTRUSTED, script NOT run", async () => {
  // The diff shows the builder changing the "test" script to a no-op that always passes.
  const attackDiff = async () =>
    [
      "diff --git a/package.json b/package.json",
      "index 1111111..2222222 100644",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -5,7 +5,7 @@",
      '   \"scripts\": {',
      '-    \"test\": \"node --test\",',
      '+    \"test\": \"echo all good && exit 0\",',
      '     \"build\": \"tsc\"',
      "   },",
    ].join("\n");
  const exec = execStub(() => { throw new Error("governed-exec must NOT run the mutated check"); });
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: attackDiff })(ctx);

  assert.equal(result.outcome, "failure", "a mutated-scripts build CANNOT pass verification (fail-closed)");
  const detail = result.detail as { verdict: string; reason?: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "untrusted");
  assert.match(result.summary ?? "", /untrusted/);
  assert.match(detail.reason ?? "", /script/);
  assert.equal(exec.calls.length, 0, "the mutated script was NEVER executed as a trusted check");
});

// ── LAYER 2: CLEAN DIFF (incl. dependency bump) → proceeds normally ──────────

test("LAYER 2 clean: a code change / dependency bump (no scripts change) → the governed checks run, no false-positive", async () => {
  const depBump = async () =>
    [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -20,7 +20,7 @@",
      '   \"dependencies\": {',
      '-    \"lodash\": \"^4.17.20\",',
      '+    \"lodash\": \"^4.17.21\",',
      "   }",
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1 +1 @@",
      "-export const x = 1;",
      "+export const x = 2;",
    ].join("\n");
  const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: depBump })(ctx);

  assert.equal(result.outcome, "success", "a legitimate build (no scripts change) verifies normally");
  assert.equal(exec.calls.length, 2, "both governed checks ran — no false-positive untrusted");
});

// ── LAYER 2: detectScriptMutation unit coverage ──────────────────────────────

test("detectScriptMutation: flags test/build/tsc + the scripts key; ignores deps and non-package files", () => {
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n-    \"test\": \"node --test\",\n+    \"test\": \"echo hi\",").mutated, true, "test script change flagged");
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n+    \"build\": \"tsc -p .\",").mutated, true, "build script add flagged");
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n-    \"pretest\": \"x\",").mutated, true, "pretest hook removal flagged");
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n+  \"scripts\": {\n+    \"foo\": \"bar\"\n+  },").mutated, true, "adding the scripts object flagged");
  assert.equal(detectScriptMutation("diff --git a/package.json b/package.json\n-    \"lodash\": \"^4.17.20\",\n+    \"lodash\": \"^4.17.21\",").mutated, false, "a dependency bump is NOT a scripts change");
  assert.equal(detectScriptMutation("diff --git a/src/test-helper.ts b/src/test-helper.ts\n+const test = 1;").mutated, false, "a non-package.json file is not flagged");
  assert.equal(detectScriptMutation("").mutated, false, "an empty diff is clean");
});

// ── DETERMINISM (regression) ─────────────────────────────────────────────────

test("verifier never invokes the model (asserted via the engine spy)", async () => {
  const exec = execStub(() => ({ executed: true, exitCode: 0 }));
  const { ctx, invokeCalls } = makeCtx();
  await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);
  assert.equal(invokeCalls(), 0);
});
