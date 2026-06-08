/**
 * CLI smoke tests (acceptance #5): the real built CLI runs the operator commands in a CLEAN
 * environment (no IKBI_* keys, a cwd with no .env) without crashing or leaking a stack trace.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const ENTRY = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const freshCwd = () => mkdtempSync(join(tmpdir(), "ikbi-smoke-"));

/** Run the built CLI in a clean env (only PATH+HOME) from a cwd with no .env. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string; combined: string } {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: freshCwd(),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, combined: `${res.stdout}\n${res.stderr}` };
}
const noStack = (s: string): boolean => !/\n\s+at\s+\S/.test(s);

test("smoke: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

test("smoke: `ikbi help` lists all commands incl. repl/undo/receipts/clean/diff", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, `help exited ${r.status}\n${r.combined}`);
  for (const cmd of ["repl", "undo", "receipts", "clean", "diff", "build", "doctor", "capabilities"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `help lists "${cmd}"`);
  }
  assert.ok(noStack(r.combined), "no stack trace");
});

test("smoke: `ikbi doctor` runs in a clean env, reports what's missing, no stack trace", () => {
  const r = runCli(["doctor"]);
  assert.equal(r.status, 0, `doctor exited ${r.status}\n${r.combined}`);
  assert.match(r.stdout, /REQUIRED FOR A BUILD/);
  assert.match(r.stdout, /IKBI_OPERATOR_TOKEN/, "tells you what's missing");
  assert.ok(noStack(r.combined), "no stack trace");
  assert.ok(!r.combined.includes("Refusing to start with insecure default trust keys"), "no fatal config throw");
});

test("smoke: `ikbi receipts` runs without error", () => {
  const r = runCli(["receipts"]);
  assert.equal(r.status, 0, `receipts exited ${r.status}\n${r.combined}`);
  assert.ok(noStack(r.combined), "no stack trace");
});

test("smoke: `ikbi clean` runs without error", () => {
  const r = runCli(["clean"]);
  assert.equal(r.status, 0, `clean exited ${r.status}\n${r.combined}`);
  assert.match(r.stdout, /reclaimed \d+ orphaned worktree/);
  assert.ok(noStack(r.combined), "no stack trace");
});

test("smoke: `ikbi diff <id>` prints a diff or a graceful 'no workspace' (no crash)", () => {
  const r = runCli(["diff", "no-such-workspace-id"]);
  // Unknown id is a graceful, fail-closed "no workspace" — never a crash/stack.
  assert.match(r.combined, /no workspace "no-such-workspace-id" found/);
  assert.ok(noStack(r.combined), "no stack trace");
});
