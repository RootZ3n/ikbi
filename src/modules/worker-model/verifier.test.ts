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

// ── LAYER 2: GUARD MANDATORY — diff-not-wired & diff-throws fail CLOSED ───────

test("LAYER 2 no-diff: a verifier built WITHOUT a diff source fails CLOSED (untrusted, zero governed-exec calls)", async () => {
  // The script-integrity guard is mandatory: with no diff to inspect, the verifier
  // cannot prove the builder didn't rewrite the test script → it must NOT verify.
  const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "would-pass" }));
  const { ctx } = makeCtx();
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx() })(ctx); // NO diff dep

  assert.equal(result.outcome, "failure", "a missing integrity guard fails closed, NOT open");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "untrusted");
  assert.deepEqual(detail.checks, [], "no checks ran");
  assert.match(result.summary ?? "", /script-integrity guard unavailable/);
  assert.equal(exec.calls.length, 0, "the governed checks NEVER ran on the no-diff path (no governed-exec call)");
});

test("LAYER 2 diff-throws: an unreadable workspace diff fails CLOSED (untrusted) — regression", async () => {
  const exec = execStub(() => { throw new Error("governed-exec must NOT run when integrity is unprovable"); });
  const { ctx } = makeCtx();
  const throwingDiff = async () => { throw new Error("git diff failed"); };
  const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: throwingDiff })(ctx);

  assert.equal(result.outcome, "failure");
  const detail = result.detail as { verdict: string; checks: CheckResult[] };
  assert.equal(detail.verdict, "untrusted");
  assert.match(result.summary ?? "", /diff unavailable/);
  assert.equal(exec.calls.length, 0, "no governed check ran when the diff could not be read");
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

// ── ISSUE 1: JSON-SEMANTIC script-integrity (full-context diffs) ─────────────

test("ISSUE-1 false-positive killed: a dependency literally named \"build\" bumped → NOT flagged", () => {
  // A FULL-context package.json diff: only a dependency named "build" changes its version. The
  // line-scan would match the guarded key "build"; the semantic pass sees it lives under
  // dependencies, scripts are unchanged → clean.
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,9 +1,9 @@",
    " {",
    '   "name": "app",',
    '   "scripts": {',
    '     "test": "node --test"',
    "   },",
    '   "dependencies": {',
    '-    "build": "^1.0.0"',
    '+    "build": "^1.1.0"',
    "   }",
    " }",
  ].join("\n");
  assert.equal(detectScriptMutation(diff).mutated, false, "a dep named 'build' bumped is NOT a scripts mutation");
});

test("ISSUE-1 false-negative killed: a separate-line \"test\":/\"echo pass\" rewrite is STILL flagged", () => {
  // The builder formats the test script with key and value on SEPARATE lines to dodge the
  // key/value line-scan. The semantic pass parses both sides → the resolved scripts.test changed.
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,5 +1,6 @@",
    " {",
    '   "scripts": {',
    '-    "test": "node --test"',
    '+    "test":',
    '+      "echo pass"',
    "   }",
    " }",
  ].join("\n");
  assert.equal(detectScriptMutation(diff).mutated, true, "separate-line key/value formatting cannot bypass the semantic compare");
});

test("ISSUE-1 actual script change (full diff) → flagged", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,5 +1,5 @@",
    " {",
    '   "scripts": {',
    '-    "test": "node --test"',
    '+    "test": "echo pass && exit 0"',
    "   }",
    " }",
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, true, "rewriting the test command is flagged");
  assert.match(r.reason ?? "", /test/);
});

test("ISSUE-1 semantic clean: a full-context diff changing only a non-guarded script is NOT flagged", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,5 +1,5 @@",
    " {",
    '   "scripts": {',
    '     "test": "node --test",',
    '-    "start": "node old.js"',
    '+    "start": "node new.js"',
    "   }",
    " }",
  ].join("\n");
  assert.equal(detectScriptMutation(diff).mutated, false, "changing a non-guarded 'start' script is not a verification mutation");
});

// ── DETERMINISM (regression) ─────────────────────────────────────────────────

test("verifier never invokes the model (asserted via the engine spy)", async () => {
  const exec = execStub(() => ({ executed: true, exitCode: 0 }));
  const { ctx, invokeCalls } = makeCtx();
  await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctx);
  assert.equal(invokeCalls(), 0);
});

test("P0/A6: detectScriptMutation flags a SUBPACKAGE package.json test-script change (not just root)", () => {
  const diff = [
    "diff --git a/packages/a/package.json b/packages/a/package.json",
    "--- a/packages/a/package.json",
    "+++ b/packages/a/package.json",
    "@@ -3,3 +3,3 @@",
    '-    "test": "vitest run",',
    '+    "test": "echo pass",',
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, true, "a subpackage test-script change is caught → verification fails closed");
});

test("P0/T1: detectScriptMutation guards the extended script keys (lint/check/e2e/coverage)", () => {
  for (const key of ["lint", "check", "e2e", "coverage", "typecheck"]) {
    const diff = `diff --git a/package.json b/package.json\n-    "${key}": "real",\n+    "${key}": "echo pass",`;
    assert.equal(detectScriptMutation(diff).mutated, true, `${key} script change flagged`);
  }
});

// ── P0 Fix 1: the script-integrity guard inspects the WORKING-TREE diff, not the empty committed range
import { execFileSync as _execFileSync } from "node:child_process";
import { mkdtempSync as _mkdtempSync, mkdirSync as _mkdirSync, writeFileSync as _writeFileSync, rmSync as _rmSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";
import { workingTreePackageJsonDiff } from "./checks.js";

test("P0/Fix1: working-tree diff catches an UNCOMMITTED package.json rewrite (root + subpackage); committed range is empty", async () => {
  const repo = _mkdtempSync(_join(_tmpdir(), "ikbi-si-"));
  try {
    const git = (args: string[]): string => _execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    try {
      git(["init", "-q"]);
      git(["config", "user.email", "t@example.com"]);
      git(["config", "user.name", "t"]);
      _writeFileSync(_join(repo, "package.json"), `${JSON.stringify({ name: "r", scripts: { test: "vitest run" } }, null, 2)}\n`);
      _mkdirSync(_join(repo, "packages", "a"), { recursive: true });
      _writeFileSync(_join(repo, "packages", "a", "package.json"), `${JSON.stringify({ name: "a", scripts: { test: "vitest run" } }, null, 2)}\n`);
      git(["add", "-A"]);
      git(["commit", "-qm", "base"]);
    } catch {
      return; // git unavailable → skip (the unit detectScriptMutation tests still cover the parser)
    }
    const base = git(["rev-parse", "HEAD"]).trim();
    // builder rewrites BOTH test scripts in the WORKING TREE, uncommitted (root → stub; subpackage → narrowed)
    _writeFileSync(_join(repo, "package.json"), `${JSON.stringify({ name: "r", scripts: { test: "echo pass" } }, null, 2)}\n`);
    _writeFileSync(_join(repo, "packages", "a", "package.json"), `${JSON.stringify({ name: "a", scripts: { test: "vitest run only-passing.test.ts" } }, null, 2)}\n`);

    // the OLD source (committed base..scratch range) is EMPTY at verify time
    assert.equal(git(["diff", `${base}..HEAD`]).trim(), "", "committed range is empty before the build commit (the old bug)");
    // the FIX: the working-tree diff sees the uncommitted rewrites
    const wt = await workingTreePackageJsonDiff(async (args) => git([...args]), repo, base);
    assert.ok(/echo pass/.test(wt), "root rewrite visible");
    assert.ok(/only-passing/.test(wt), "subpackage rewrite visible");
    assert.equal(detectScriptMutation(wt).mutated, true, "→ script-integrity fails closed at verify time");
  } finally {
    _rmSync(repo, { recursive: true, force: true });
  }
});

test("P0/Fix1: a non-stub NARROWED test script is caught by detectScriptMutation", () => {
  const diff = 'diff --git a/package.json b/package.json\n-    "test": "vitest run",\n+    "test": "vitest run only-passing.test.ts",';
  assert.equal(detectScriptMutation(diff).mutated, true, "narrowing a real test command is a guarded-script change");
});

test("P0/Fix1: a package.json change OUTSIDE guarded scripts does NOT false-trip", () => {
  const diff = 'diff --git a/package.json b/package.json\n-    "lodash": "^4.17.20",\n+    "lodash": "^4.17.21",';
  assert.equal(detectScriptMutation(diff).mutated, false, "a dependency bump is not a script mutation");
});

// ── L4: greenfield tsconfig.json ──────────────────────────────────────────────

test("L4: greenfield tsconfig.json with 'new file mode' is NOT flagged for weakening keys", () => {
  const diff = [
    "diff --git a/tsconfig.json b/tsconfig.json",
    "new file mode 100644",
    "index 0000000..abc1234",
    "--- /dev/null",
    "+++ b/tsconfig.json",
    '+  "compilerOptions": {',
    '+    "strict": true,',
    '+    "skipLibCheck": true,',
    '+    "target": "ES2022"',
    "+  }",
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, false, "new file tsconfig with skipLibCheck should NOT be flagged — can't weaken what didn't exist");
});

test("L4: greenfield tsconfig.json with '--- /dev/null' (untracked) is NOT flagged for weakening keys", () => {
  const diff = [
    "diff --git a/tsconfig.json b/tsconfig.json",
    "--- /dev/null",
    "+++ b/tsconfig.json",
    '+  "compilerOptions": {',
    '+    "skipLibCheck": true',
    "+  }",
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, false, "untracked new tsconfig with skipLibCheck should NOT be flagged");
});

test("L4: MODIFIED tsconfig.json with weakening key IS still flagged", () => {
  const diff = [
    "diff --git a/tsconfig.json b/tsconfig.json",
    "--- a/tsconfig.json",
    "+++ b/tsconfig.json",
    '-  "skipLibCheck": false,',
    '+  "skipLibCheck": true,',
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, true, "changing skipLibCheck on an existing tsconfig IS a mutation");
});

test("L4: 'new file mode' detection sets isNewFile for guarded config files too", () => {
  // A new vitest.config.ts should NOT be flagged (can't weaken what didn't exist)
  const diff = [
    "diff --git a/vitest.config.ts b/vitest.config.ts",
    "new file mode 100644",
    "index 0000000..abc1234",
    "--- /dev/null",
    "+++ b/vitest.config.ts",
    "+export default { test: { include: ['**/*.test.ts'] } }",
  ].join("\n");
  const r = detectScriptMutation(diff);
  assert.equal(r.mutated, false, "new vitest.config.ts should NOT be flagged");
});

// ── ISSUE 3: stub-script detector runs in LEGACY mode ────────────────────────

/** Build a verifier ctx whose workspace points at a real on-disk directory. */
function ctxAt(dir: string): RoleContext {
  const { ctx } = makeCtx();
  (ctx.workspace as { path: string }).path = dir;
  return ctx;
}

test("ISSUE-3 legacy: a stub test script ('echo ok') fails closed even though the checks exit 0", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-stub-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "echo ok" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "failure", "a no-op test script is not meaningful verification (legacy parity with the ladder)");
    const detail = result.detail as { verdict: string; reason?: string };
    assert.equal(detail.verdict, "fail");
    assert.match(result.summary ?? "", /stub test script/);
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("ISSUE-3 legacy: a --passWithNoTests test script is a stub → fails closed", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-stub2-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest --passWithNoTests" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "failure", "--passWithNoTests is a trivially-green stub");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});

test("ISSUE-3 legacy: a REAL test script ('node --test') passes the stub guard", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "ikbi-real-"));
  try {
    _writeFileSync(_join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
    const exec = execStub(() => ({ executed: true, exitCode: 0, stdoutTail: "ok" }));
    const result = await createVerifier({ governedExec: exec.governedExec, parentCtx: makeParentCtx(), diff: cleanDiff })(ctxAt(dir));
    assert.equal(result.outcome, "success", "a real test script is not flagged as a stub");
  } finally {
    _rmSync(dir, { recursive: true, force: true });
  }
});
