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

/**
 * Run the built CLI in a clean env (no IKBI_* keys) from a cwd with no .env, with an ISOLATED HOME so
 * the default state root (`<HOME>/.ikbi/state`) is a fresh temp dir per run — the smoke suite never
 * depends on, or contends with, the user's real `~/.ikbi/state` (Codex blocker 2). An optional
 * `extraEnv` injects per-test overrides (e.g. a tiny lock timeout for the live-lock scenario).
 */
function runCli(args: string[], extraEnv: Record<string, string> = {}, input?: string): { status: number | null; stdout: string; stderr: string; combined: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "ikbi-smoke-home-"));
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: freshCwd(),
    env: { PATH: process.env.PATH ?? "", HOME: home, ...extraEnv },
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, combined: `${res.stdout}\n${res.stderr}`, home };
}
const noStack = (s: string): boolean => !/\n\s+at\s+\S/.test(s);

test("smoke: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

test("smoke: `ikbi help` shows the focused core commands (no startup-log leak)", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, `help exited ${r.status}\n${r.combined}`);
  // The default help is intentionally tight (~6 commands); the long tail is behind --advanced.
  for (const cmd of ["init", "build", "models", "serve", "help"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `help lists "${cmd}"`);
  }
  assert.match(r.stdout, /ikbi help --advanced/, "points to --advanced for the full list");
  // Startup/config diagnostics must NOT leak into a user-facing command's output (even when piped).
  assert.doesNotMatch(r.combined, /"level":"(info|debug|warn)"/, "no structured startup logs leaked");
  assert.ok(noStack(r.combined), "no stack trace");
});

test("smoke: `ikbi help --advanced` lists all commands incl. repl/undo/receipts/clean/diff", () => {
  const r = runCli(["help", "--advanced"]);
  assert.equal(r.status, 0, `help --advanced exited ${r.status}\n${r.combined}`);
  for (const cmd of ["repl", "undo", "receipts", "clean", "diff", "build", "doctor", "capabilities"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `help --advanced lists "${cmd}"`);
  }
  assert.ok(noStack(r.combined), "no stack trace");
});

test("smoke: `ikbi help <command>` shows the command's detailed page", () => {
  const r = runCli(["help", "build"]);
  assert.equal(r.status, 0, `help build exited ${r.status}\n${r.combined}`);
  assert.match(r.stdout, /^ikbi build —/m, "leads with the command's one-liner");
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /Examples:/);
  assert.match(r.stdout, /--max-budget-usd/, "documents the flags");
  assert.match(r.stdout, /See also:/);
  assert.ok(noStack(r.combined), "no stack trace");
  // Each of the required topics resolves to a page (not the general usage).
  for (const topic of ["init", "models", "serve", "repl"]) {
    const p = runCli(["help", topic]);
    assert.match(p.stdout, new RegExp(`^ikbi ${topic} —`, "m"), `help ${topic} shows its page`);
  }
});

test("smoke: `ikbi` with no args opens the REPL (not the usage screen), with zero noise", () => {
  // Empty stdin ⇒ the REPL reads no message and exits cleanly. The point of the test is the
  // FIRST thing the user sees is the REPL, not the help/usage text, and nothing leaks.
  const r = runCli([], {}, "");
  assert.equal(r.status, 0, `no-args exited ${r.status}\n${r.combined}`);
  assert.match(r.stdout, /ikbi repl/, "the REPL opened");
  assert.doesNotMatch(r.stdout, /governed build\/repair engine/, "did NOT print the usage screen");
  assert.doesNotMatch(r.stdout, /ikbi help --advanced/, "did NOT print the usage screen");
  // Zero noise: no structured startup logs, no stack trace, no fatal config throw.
  assert.doesNotMatch(r.combined, /"level":"(info|debug|warn)"/, "no structured startup logs leaked");
  assert.ok(noStack(r.combined), "no stack trace");
  assert.ok(!r.combined.includes("Refusing to start with insecure default trust keys"), "no fatal config throw");
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
