/**
 * `ikbi fix` CLI — argument parsing, governed check wiring, receipt rendering, and exit codes.
 *
 * The pipeline itself is covered in worker-model/fix.test.ts; here we verify the COMMAND glue:
 * the check routes through governed-exec under the operator ctx, a correct refusal exits 0
 * (success), an unsafe/unresolved outcome exits non-zero, and a missing operator token fails
 * closed before any run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { IdentityResolver } from "../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../core/identity/registry.js";
import type { ExecRequest, ExecResult } from "../modules/governed-exec/index.js";
import type { CheckRun, FixCheckCommand, FixOptions, FixOutcome } from "../modules/worker-model/fix.js";
import type { FixReceipt, FixResult } from "../modules/worker-model/fix-receipt.js";
import { createFixCli, parseFixArgs, splitCheck } from "./fix.js";

const OPERATOR_TOKEN = "operator-secret-token-aaaaaaaaaaaaaaaa";

function makeResolver() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "op", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken(OPERATOR_TOKEN)] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return (claim: { token: string }) => resolver.resolve(claim);
}

function capture() {
  let out = "";
  let errOut = "";
  let exit = 0;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (errOut += s),
    setExit: (c: number) => void (exit = c),
    get out() {
      return out;
    },
    get err() {
      return errOut;
    },
    get exit() {
      return exit;
    },
  };
}

function fakeOutcome(result: FixResult, antiCheatPassed = true): FixOutcome {
  const receipt: FixReceipt = {
    started: { timestamp: "t", repo: "/repo", check: "python3 -m pytest -q", head: "h" },
    failureReproduced: { exitCode: 1, outcomes: { passed: false, failingTests: ["t::a"], collectionError: false, summary: "FAILED" }, rawOutput: "" },
    diagnosis: { category: "implementation_bug", confidence: 0.9, evidence: "e", affectedFiles: ["a.py"] },
    plan: { files: ["a.py"], change: "c", why: "w" },
    patchApplied: { diff: "", filesModified: [] },
    targetedCheck: { passed: true, output: "" },
    fullCheck: { passed: true, regressionCount: 0 },
    antiCheat: { passed: antiCheatPassed, checks: [{ name: "no_test_weakening", passed: antiCheatPassed, evidence: "ok" }] },
    result,
    promoted: false,
  };
  return { result, receipt, promoted: false, filesModified: [], diagnosis: receipt.diagnosis };
}

test("parseFixArgs: repo + flags", () => {
  const a = parseFixArgs(["/my/repo", "--check", "pytest -q tests", "--allow-test-edits", "--diagnose-only", "--max-files", "3"]);
  assert.equal(a.repo, "/my/repo");
  assert.deepEqual(a.check, { command: "pytest", args: ["-q", "tests"] });
  assert.equal(a.allowTestEdits, true);
  assert.equal(a.diagnoseOnly, true);
  assert.equal(a.maxFiles, 3);
});

test("splitCheck: tokenizes a check string (and rejects empties)", () => {
  assert.deepEqual(splitCheck("python3 -m pytest -q"), { command: "python3", args: ["-m", "pytest", "-q"] });
  assert.equal(splitCheck("   "), undefined);
  assert.equal(splitCheck(undefined), undefined);
});

test("fix CLI: routes the check through governed-exec and prints the receipt; FIXED_NARROWLY exits 0", async () => {
  const cap = capture();
  const execCalls: ExecRequest[] = [];
  const governedExec = {
    run: async (req: ExecRequest): Promise<ExecResult> => {
      execCalls.push(req);
      return { executed: true, exitCode: 1, stdoutTail: "FAILED test", stderrTail: "" };
    },
  };
  let seenCheckRun: CheckRun | undefined;
  const runPipeline = async (_opts: FixOptions, deps: { runCheck: (repo: string, check: FixCheckCommand) => Promise<CheckRun> }): Promise<FixOutcome> => {
    seenCheckRun = await deps.runCheck("/repo", { command: "python3", args: ["-m", "pytest", "-q"] });
    return fakeOutcome("FIXED_NARROWLY");
  };

  const cli = createFixCli({ resolveIdentity: makeResolver(), operatorToken: OPERATOR_TOKEN, governedExec, runPipeline, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit });
  await cli.fix(["/repo"]);

  assert.equal(execCalls.length, 1, "the check ran through governed-exec");
  assert.equal(execCalls[0]!.command, "python3");
  assert.equal(seenCheckRun?.exitCode, 1);
  assert.match(cap.out, /fix FIXED_NARROWLY/);
  assert.match(cap.out, /anti-cheat:  PASS/);
  assert.equal(cap.exit, 0, "a narrow fix is a success");
});

test("fix CLI: CORRECT_REFUSAL is a success (exit 0)", async () => {
  const cap = capture();
  const cli = createFixCli({
    resolveIdentity: makeResolver(),
    operatorToken: OPERATOR_TOKEN,
    governedExec: { run: async () => ({ executed: true, exitCode: 1, stdoutTail: "FAILED" }) },
    runPipeline: async () => fakeOutcome("CORRECT_REFUSAL"),
    stdout: cap.stdout,
    stderr: cap.stderr,
    setExit: cap.setExit,
  });
  await cli.fix(["/repo"]);
  assert.match(cap.out, /fix CORRECT_REFUSAL/);
  assert.equal(cap.exit, 0);
});

test("fix CLI: UNSAFE_FAIL exits non-zero", async () => {
  const cap = capture();
  const cli = createFixCli({
    resolveIdentity: makeResolver(),
    operatorToken: OPERATOR_TOKEN,
    governedExec: { run: async () => ({ executed: true, exitCode: 0, stdoutTail: "passed" }) },
    runPipeline: async () => fakeOutcome("UNSAFE_FAIL", false),
    stdout: cap.stdout,
    stderr: cap.stderr,
    setExit: cap.setExit,
  });
  await cli.fix(["/repo"]);
  assert.match(cap.out, /fix UNSAFE_FAIL/);
  assert.equal(cap.exit, 1);
});

test("fix CLI: a denied governed check is surfaced as a non-zero CheckRun (fail-closed)", async () => {
  let seen: CheckRun | undefined;
  const cli = createFixCli({
    resolveIdentity: makeResolver(),
    operatorToken: OPERATOR_TOKEN,
    governedExec: { run: async (): Promise<ExecResult> => ({ executed: false, denied: true, reason: "python3 not on the allowlist" }) },
    runPipeline: async (_o, deps) => {
      seen = await deps.runCheck("/repo", { command: "python3", args: ["-m", "pytest"] });
      return fakeOutcome("TOOL_LIMITATION");
    },
    stdout: () => {},
    stderr: () => {},
    setExit: () => {},
  });
  await cli.fix(["/repo"]);
  assert.equal(seen?.exitCode, 126);
  assert.match(seen?.output ?? "", /DENIED/);
});

test("fix CLI: no operator token fails closed before any run", async () => {
  const cap = capture();
  let ran = false;
  const cli = createFixCli({
    resolveIdentity: makeResolver(),
    operatorToken: undefined,
    governedExec: { run: async () => ({ executed: true }) },
    runPipeline: async () => {
      ran = true;
      return fakeOutcome("FIXED_NARROWLY");
    },
    stdout: cap.stdout,
    stderr: cap.stderr,
    setExit: cap.setExit,
  });
  await cli.fix(["/repo"]);
  assert.equal(ran, false);
  assert.match(cap.err, /no operator identity/);
  assert.equal(cap.exit, 1);
});
