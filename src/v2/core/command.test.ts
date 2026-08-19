/**
 * V2-015 — THE BUILDER COMMAND AUTHORITY (pure).
 *
 * These suites pin the read-only terminal's structural guarantees: a tiny allowlist that refuses
 * every write/interpreter/network/escape vector BEFORE anything runs, argv that is never a shell,
 * content-addressed command records, bounded output, and a policy whose id moves when it changes.
 * The OS-level and tree-invariant proofs live in command-executor.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  V2_DEFAULT_COMMAND_POLICY,
  buildCommandPolicy,
  evaluateCommand,
  validateRelativeCwd,
  boundCommandOutput,
  buildCommandRecord,
  commandRefusalOutcome,
  commandLaunchedOutcome,
  type BuilderCommandRecord,
} from "./command.js";
import type { V2RunId } from "./identity.js";

const POLICY = V2_DEFAULT_COMMAND_POLICY;
const ok = (program: string, args: readonly string[] = []) => evaluateCommand(POLICY, { program, args });

// ---------------------------------------------------------------------------
// Allowed read-only commands
// ---------------------------------------------------------------------------

test("policy: read-only git subcommands are allowed", () => {
  for (const sub of ["status", "diff", "log", "show", "grep", "rev-parse", "ls-files", "ls-tree", "blame"]) {
    assert.equal(ok("git", [sub]).ok, true, `git ${sub} should be allowed`);
  }
  assert.equal(ok("git", ["diff", "--stat"]).ok, true);
  assert.equal(ok("git", ["rev-parse", "--abbrev-ref", "HEAD"]).ok, true);
});

test("policy: read-only inspection tools are allowed", () => {
  assert.equal(ok("grep", ["-rn", "foo", "src"]).ok, true);
  assert.equal(ok("find", ["src", "-name", "*.ts"]).ok, true);
  assert.equal(ok("ls", ["-la"]).ok, true);
  assert.equal(ok("wc", ["-l", "src/a.ts"]).ok, true);
});

// ---------------------------------------------------------------------------
// Mutating / dangerous programs are refused
// ---------------------------------------------------------------------------

test("policy: mutating git verbs are ABSENT from the allowlist and refused", () => {
  for (const sub of ["add", "commit", "checkout", "switch", "reset", "clean", "restore", "merge", "rebase", "cherry-pick", "apply", "am", "stash", "tag", "branch", "update-ref", "config", "push", "fetch", "pull", "clone", "ls-remote", "remote", "init", "gc"]) {
    const v = ok("git", [sub]);
    assert.equal(v.ok, false, `git ${sub} must be refused`);
    assert.equal(v.code, "subcommand_not_allowed");
  }
});

test("policy: interpreters, editors, package managers, network and file-writers are refused", () => {
  for (const program of ["sh", "bash", "zsh", "python", "python3", "node", "sed", "rm", "mv", "cp", "touch", "cat", "curl", "wget", "npm", "pnpm", "pip", "perl", "awk", "tee", "dd", "chmod", "ln"]) {
    const v = ok(program, ["whatever"]);
    assert.equal(v.ok, false, `${program} must be refused`);
    assert.equal(v.code, "program_not_allowed");
  }
});

test("policy: a program given as a PATH (not a bare name) is refused", () => {
  assert.equal(ok("/bin/sh").code, "program_has_path");
  assert.equal(ok("./evil").code, "program_has_path");
  assert.equal(ok("../bin/git", ["status"]).code, "program_has_path");
});

test("policy: git escape flags before the subcommand are refused (verb must be args[0])", () => {
  // `git -C /etc status`, `git -c core.hooksPath=x status`, `git --git-dir=… status` — the leading
  // flag means the read-only verb is NOT args[0], so it is refused.
  assert.equal(ok("git", ["-C", "/etc", "status"]).code, "subcommand_not_allowed");
  assert.equal(ok("git", ["-c", "core.hooksPath=/x", "status"]).code, "subcommand_not_allowed");
  assert.equal(ok("git", ["--git-dir=/other/.git", "status"]).code, "subcommand_not_allowed");
});

test("policy: an allowed git verb with a WRITE flag is refused", () => {
  // `git diff --output=FILE` would write FILE even though `diff` is read-only.
  assert.equal(ok("git", ["diff", "--output=/tmp/x"]).code, "denied_argument");
  assert.equal(ok("git", ["log", "--output", "x"]).code, "denied_argument");
});

test("policy: find WRITE/EXEC actions are refused; read-only traversal is allowed", () => {
  assert.equal(ok("find", [".", "-delete"]).code, "denied_argument");
  assert.equal(ok("find", [".", "-exec", "rm", "{}", ";"]).code, "denied_argument");
  assert.equal(ok("find", [".", "-name", "*.ts"]).ok, true);
});

test("policy: too many args is refused", () => {
  assert.equal(ok("ls", Array.from({ length: POLICY.maxArgs + 1 }, () => "x")).code, "too_many_args");
});

// ---------------------------------------------------------------------------
// No shell — metacharacters are ordinary argv
// ---------------------------------------------------------------------------

test("no shell: redirection/metacharacters are LITERAL arguments, not interpreted", () => {
  // `echo ">" foo` is allowed BECAUSE ">" is just a string argument — there is no shell to
  // redirect. The same holds for &&, ;, |, $(), backticks: all ordinary argv.
  for (const meta of [">", ">>", "|", "&&", ";", "$(touch x)", "`touch x`", "*", "../../etc/passwd"]) {
    assert.equal(ok("echo", [meta, "foo"]).ok, true, `"${meta}" must be an ordinary argument to echo`);
  }
});

// ---------------------------------------------------------------------------
// CWD confinement (pure precheck)
// ---------------------------------------------------------------------------

test("cwd: relative paths inside the workspace pass; escapes are refused", () => {
  assert.deepEqual(validateRelativeCwd("."), { ok: true, normalized: "." });
  assert.deepEqual(validateRelativeCwd("src/inner"), { ok: true, normalized: "src/inner" });
  assert.equal(validateRelativeCwd("/etc").ok, false);
  assert.equal(validateRelativeCwd("../outside").ok, false);
  assert.equal(validateRelativeCwd("src/../../x").ok, false);
  assert.equal(validateRelativeCwd("C:\\Windows").ok, false);
});

// ---------------------------------------------------------------------------
// Output bounding
// ---------------------------------------------------------------------------

test("output: short output is kept whole; long output is tail-truncated with the FULL hash", () => {
  const short = boundCommandOutput("hello", 100);
  assert.equal(short.excerpt, "hello");
  assert.equal(short.truncated, false);

  const long = "a".repeat(50) + "TAIL";
  const bounded = boundCommandOutput(long, 10);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.excerpt.endsWith("TAIL"), true, "the diagnostics-bearing tail is kept");
  assert.equal(bounded.byteLength, 54, "the FULL length is recorded");
  assert.equal(bounded.sha256, boundCommandOutput(long, 999_999).sha256, "the hash is of the FULL output regardless of truncation");
});

// ---------------------------------------------------------------------------
// Command record identity
// ---------------------------------------------------------------------------

function record(over: Partial<Parameters<typeof buildCommandRecord>[0]> = {}): BuilderCommandRecord {
  return buildCommandRecord({
    runId: "run_seed-00000001" as V2RunId,
    ordinal: 1,
    policyId: POLICY.policyId,
    program: "git",
    args: ["status", "--short"],
    cwd: ".",
    workspaceAccess: "read_only",
    network: "deny",
    sandboxMode: "unsandboxed_read_only",
    launched: true,
    exitCode: 0,
    timedOut: false,
    timeoutMs: POLICY.timeoutMs,
    durationMs: 12,
    output: boundCommandOutput("clean", POLICY.maxOutputBytes),
    treeBefore: "tree-abc",
    treeAfter: "tree-abc",
    ...over,
  });
}

test("record: content-addressed, workspaceMutated always false, timings excluded from identity", () => {
  const a = record({ durationMs: 5 });
  const b = record({ durationMs: 5000 });
  assert.equal(a.commandId, b.commandId, "duration is provenance, not identity");
  assert.equal(a.workspaceMutated, false);
  assert.equal(a.commandPolicyId, POLICY.policyId);
});

test("record: a different command / cwd / ordinal / tree yields a different id", () => {
  const base = record();
  assert.notEqual(record({ ordinal: 2 }).commandId, base.commandId);
  assert.notEqual(record({ args: ["log"] }).commandId, base.commandId);
  assert.notEqual(record({ cwd: "src" }).commandId, base.commandId);
  assert.notEqual(record({ treeBefore: "tree-xyz" }).commandId, base.commandId);
});

// ---------------------------------------------------------------------------
// Outcome builders
// ---------------------------------------------------------------------------

test("outcome: a refusal is a tool failure carrying no output; a launch is not (any exit code)", () => {
  const refused = commandRefusalOutcome({ program: "sh", args: ["-c", "x"], cwd: ".", code: "program_not_allowed", detail: "sh is not allowed" });
  assert.equal(refused.kind, "command");
  if (refused.kind === "command") {
    assert.equal(refused.refused, true);
    assert.equal(refused.launched, false);
    assert.equal(refused.workspaceUnchanged, true);
  }
  const launched = commandLaunchedOutcome(record({ exitCode: 1 }));
  if (launched.kind === "command") {
    assert.equal(launched.refused, false);
    assert.equal(launched.exitCode, 1, "a non-zero exit is a normal result, not a refusal");
    assert.equal(launched.workspaceUnchanged, true);
  }
});

// ---------------------------------------------------------------------------
// Policy identity / freeze
// ---------------------------------------------------------------------------

test("policy identity: it is deterministic, and a changed rule/bound moves the policy id", () => {
  // Rebuilding from the same inputs reproduces the id (frozen for a session).
  const rebuilt = buildCommandPolicy({ rules: POLICY.rules, workspaceAccess: POLICY.workspaceAccess, network: POLICY.network, maxCommands: POLICY.maxCommands, timeoutMs: POLICY.timeoutMs, maxOutputBytes: POLICY.maxOutputBytes, maxArgs: POLICY.maxArgs });
  assert.equal(rebuilt.policyId, POLICY.policyId);
  const widened = buildCommandPolicy({ ...POLICY, rules: [...POLICY.rules, { program: "cat", mode: "freeform" }] });
  assert.notEqual(widened.policyId, POLICY.policyId);
  const tighter = buildCommandPolicy({ ...POLICY, maxCommands: POLICY.maxCommands + 1 });
  assert.notEqual(tighter.policyId, POLICY.policyId);
});
