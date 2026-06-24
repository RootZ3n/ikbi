import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { OperationContext } from "../../../core/identity/index.js";
import type { ExecRequest, ExecResult } from "../../governed-exec/index.js";
import { confinePath } from "./confine.js";
import { runPatch } from "./patch.js";
import { runSearchFiles } from "./search-files.js";
import { runTerminal, tokenizeCommand } from "./terminal.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-builder-tools-"));

// ── confinePath (the shared invariant) ─────────────────────────────────────

test("confinePath: a nested path resolves inside the worktree", () => {
  const dir = tmp();
  const c = confinePath(dir, "src/a.ts");
  assert.ok(c.ok);
  if (c.ok) assert.equal(c.rel, "src/a.ts");
});

test("confinePath: rejects a `..` traversal escape", () => {
  const dir = tmp();
  const c = confinePath(dir, "../../etc/passwd");
  assert.equal(c.ok, false);
});

test("confinePath: rejects an absolute path outside the worktree", () => {
  const dir = tmp();
  const c = confinePath(dir, "/etc/passwd");
  assert.equal(c.ok, false);
});

test("confinePath: rejects a symlink that escapes the worktree", () => {
  const dir = tmp();
  symlinkSync("/etc", join(dir, "escape"));
  const c = confinePath(dir, "escape/passwd");
  assert.equal(c.ok, false);
});

// ── search_files ───────────────────────────────────────────────────────────

test("search_files: finds a matching line and returns path:line:text", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.ts"), "const needle = 1;\nconst other = 2;\n");
  const res = runSearchFiles(dir, { pattern: "needle" });
  assert.match(res.output, /needle/);
  assert.equal(res.rejection, undefined);
});

test("search_files: a no-match search is a normal (non-error) outcome", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.ts"), "nothing here\n");
  const res = runSearchFiles(dir, { pattern: "zzz_absent_zzz" });
  assert.match(res.output, /No matches/);
  assert.equal(res.rejection, undefined);
});

test("search_files: honors a file_glob filter", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.ts"), "target\n");
  writeFileSync(join(dir, "b.md"), "target\n");
  const res = runSearchFiles(dir, { pattern: "target", file_glob: "*.ts" });
  assert.match(res.output, /a\.ts/);
  assert.doesNotMatch(res.output, /b\.md/);
});

test("search_files: a sub-path that escapes the worktree is rejected", () => {
  const dir = tmp();
  const res = runSearchFiles(dir, { pattern: "x", path: "../.." });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /escapes the worktree/);
});

test("search_files: an empty pattern is rejected", () => {
  const dir = tmp();
  const res = runSearchFiles(dir, { pattern: "" });
  assert.notEqual(res.rejection, undefined);
});

// L2: a malformed regex must yield ACTIONABLE guidance, not an opaque "search failed".
test("search_files: a malformed regex returns actionable 'Invalid regex pattern' guidance", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.ts"), "some content\n");
  // Unbalanced group — invalid in both rg and JS RegExp, so the message holds with or without rg.
  const res = runSearchFiles(dir, { pattern: "foo(" });
  assert.match(res.output, /Invalid regex pattern/i, "names the failure clearly");
  assert.match(res.output, /escape special characters/i, "tells the model how to fix it");
});

// ── patch ──────────────────────────────────────────────────────────────────

test("patch: replaces a unique occurrence and records the written file", () => {
  const dir = tmp();
  writeFileSync(join(dir, "g.ts"), "export const helo = 1;\n");
  const res = runPatch(dir, { path: "g.ts", old_string: "helo", new_string: "hello" });
  assert.equal(res.rejection, undefined);
  assert.equal(res.wrote, "g.ts");
  assert.equal(readFileSync(join(dir, "g.ts"), "utf8"), "export const hello = 1;\n");
});

test("patch: a non-unique old_string is rejected (ambiguous)", () => {
  const dir = tmp();
  writeFileSync(join(dir, "g.ts"), "x x\n");
  const res = runPatch(dir, { path: "g.ts", old_string: "x", new_string: "y" });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /must be unique/);
  // file unchanged
  assert.equal(readFileSync(join(dir, "g.ts"), "utf8"), "x x\n");
});

test("patch: a missing old_string is rejected", () => {
  const dir = tmp();
  writeFileSync(join(dir, "g.ts"), "abc\n");
  const res = runPatch(dir, { path: "g.ts", old_string: "zzz", new_string: "y" });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /not found/);
});

test("patch: a path escaping the worktree is rejected and writes nothing", () => {
  const dir = tmp();
  const res = runPatch(dir, { path: "../escape.ts", old_string: "a", new_string: "b" });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /escapes the worktree/);
});

test("patch: an empty new_string performs a deletion", () => {
  const dir = tmp();
  writeFileSync(join(dir, "g.ts"), "keep DELETE keep\n");
  const res = runPatch(dir, { path: "g.ts", old_string: " DELETE", new_string: "" });
  assert.equal(res.rejection, undefined);
  assert.equal(readFileSync(join(dir, "g.ts"), "utf8"), "keep keep\n");
});

// ── terminal (governed) ─────────────────────────────────────────────────────

test("tokenizeCommand: splits on whitespace and honors quotes", () => {
  assert.deepEqual(tokenizeCommand("git status"), ["git", "status"]);
  assert.deepEqual(tokenizeCommand('git commit -m "a b c"'), ["git", "commit", "-m", "a b c"]);
  assert.deepEqual(tokenizeCommand("ls   src"), ["ls", "src"]);
  assert.deepEqual(tokenizeCommand("echo 'x y'"), ["echo", "x y"]);
});

test("tokenizeCommand (RC7): escaped quotes inside double quotes", () => {
  assert.deepEqual(tokenizeCommand('echo "hello \\"world\\""'), ["echo", 'hello "world"']);
  // The whole quoted span with inner escaped quotes is one token.
  assert.deepEqual(tokenizeCommand('printf "%s" "a \\"b\\" c"'), ["printf", "%s", 'a "b" c']);
});

test("tokenizeCommand (RC7): escaped quotes inside single quotes", () => {
  assert.deepEqual(tokenizeCommand("echo 'hello \\'world\\''"), ["echo", "hello 'world'"]);
});

test("tokenizeCommand (RC7): escaped backslashes collapse (Windows-style path)", () => {
  assert.deepEqual(tokenizeCommand('echo "path\\\\to\\\\file"'), ["echo", "path\\to\\file"]);
});

test("tokenizeCommand (RC7): regex backslashes inside quotes are preserved", () => {
  // `\d` and `\b` are NOT valid quote/backslash escapes, so they survive verbatim.
  assert.deepEqual(tokenizeCommand('grep "\\d+"'), ["grep", "\\d+"]);
  assert.deepEqual(tokenizeCommand("grep '\\bword\\b'"), ["grep", "\\bword\\b"]);
});

test("tokenizeCommand (RC7): unquoted escape and mixed args with spaces", () => {
  // Unquoted backslash escapes the next char (here, a literal space joins the token).
  assert.deepEqual(tokenizeCommand("touch a\\ b"), ["touch", "a b"]);
  assert.deepEqual(tokenizeCommand('git commit -m "fix: a \\"quoted\\" word" --amend'), [
    "git", "commit", "-m", 'fix: a "quoted" word', "--amend",
  ]);
});

test("tokenizeCommand (RC7): an unterminated quote fails clearly", () => {
  assert.throws(() => tokenizeCommand('echo "unterminated'), /unterminated double quote/);
  assert.throws(() => tokenizeCommand("echo 'nope"), /unterminated single quote/);
});

/** A governed exec spy: records the request, returns a scripted result. */
function execSpy(result: ExecResult) {
  const calls: ExecRequest[] = [];
  return {
    calls,
    exec: { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return result; } },
  };
}

const FAKE_CTX = { requestId: "r" } as unknown as OperationContext;

test("terminal: routes a command through governed-exec with array args + worktree cwd", async () => {
  const dir = tmp();
  const spy = execSpy({ executed: true, exitCode: 0, stdoutTail: "clean", stderrTail: "" });
  const out = await runTerminal({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, { command: "git status" });
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0]?.command, "git");
  assert.deepEqual(spy.calls[0]?.args, ["status"]);
  assert.equal(spy.calls[0]?.cwd, dir);
  assert.match(out, /exit 0/);
  assert.match(out, /clean/);
});

test("terminal: surfaces a governed-exec DENIED verdict to the model", async () => {
  const dir = tmp();
  const spy = execSpy({ executed: false, denied: true, reason: "binary not on allowlist" });
  const out = await runTerminal({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, { command: "rm -rf /" });
  assert.match(out, /DENIED/);
  assert.match(out, /allowlist/);
});

test("terminal: fails closed without a parent identity (no governed authorization)", async () => {
  const dir = tmp();
  const spy = execSpy({ executed: true, exitCode: 0 });
  const out = await runTerminal({ governedExec: spy.exec }, dir, { command: "git status" });
  assert.match(out, /no parent identity/);
  assert.equal(spy.calls.length, 0, "nothing is executed when fail-closed");
});

test("terminal: an empty command is rejected before any exec", async () => {
  const dir = tmp();
  const spy = execSpy({ executed: true, exitCode: 0 });
  const out = await runTerminal({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, { command: "   " });
  assert.match(out, /non-empty 'command'/);
  assert.equal(spy.calls.length, 0);
});

test("terminal: denies effectful git and package-manager script commands before exec", async () => {
  const dir = tmp();
  for (const command of ["git -C /tmp status", "git push origin main", "git update-ref refs/heads/main HEAD", "git branch -D main", "pnpm run build", "npm test", "npx tsx script.ts"]) {
    const spy = execSpy({ executed: true, exitCode: 0 });
    const out = await runTerminal({ governedExec: spy.exec, parentCtx: FAKE_CTX }, dir, { command });
    assert.match(out, /DENIED:/, command);
    assert.equal(spy.calls.length, 0, `${command} must not reach governed-exec`);
  }
});
