/**
 * PRODUCTION REACHABILITY (end-to-end half) — REQUIRES `pnpm build`.
 *
 * Real argv -> the real built binary -> `src/cli/index.ts`'s dispatcher -> the
 * registered v2 command -> the canonical v2 lifecycle. Nothing is stubbed and
 * nothing is imported: if the CLI ever stopped routing through the v2 spine (a
 * shortcut, a stale registration, a mock left behind), the journal and receipt this
 * suite parses would not exist and it would fail.
 *
 * It also pins the safety properties an operator is entitled to assume about an
 * experimental command: it changes nothing in the repository it is pointed at.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { V2RunResult } from "../core/result.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "ikbi-v2-home-"));
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-cwd-")),
    env: { PATH: process.env.PATH ?? "", HOME: home },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("v2 cli: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

test("v2 cli: `ikbi v2 build` reaches the canonical v2 lifecycle end-to-end", () => {
  const r = runCli(["v2", "build", "a real goal", "--repo", REPO, "--json"]);
  assert.equal(r.status, 1, `expected a non-zero exit for an unimplemented lifecycle\n${r.stderr}`);
  const result = JSON.parse(r.stdout) as V2RunResult;
  assert.ok(result.taskId.startsWith("task_"));
  assert.ok(result.runId.startsWith("run_"));
  // Only the lifecycle machine writes this journal.
  assert.equal(result.journal[0]?.from, "pending");
  assert.equal(result.journal[0]?.to, "preflight");
  assert.equal(result.journal.at(-1)?.to, "terminal");
  assert.deepEqual(result.receipt.stagesEntered, ["preflight"]);
});

test("v2 cli: the end-to-end run claims NOTHING it did not do", () => {
  const r = runCli(["v2", "build", "promote everything", "--repo", REPO, "--json"]);
  const result = JSON.parse(r.stdout) as V2RunResult;
  assert.equal(result.outcome.kind, "failed");
  assert.deepEqual(result.receipt.evidence, {
    providerInvoked: false,
    invocations: 0,
    candidatesCreated: 0,
    verificationsPerformed: 0,
    promotionsAttempted: 0,
    promoted: false,
    repositoryMutated: false,
  });
});

test("v2 cli: it is safe to point at a real repository — nothing is written", () => {
  const before = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).stdout;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout;
  runCli(["v2", "build", "rewrite the world", "--repo", REPO]);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).stdout, before, "working tree unchanged");
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout, head, "HEAD unchanged");
});

test("v2 cli: shadow and tournament strategies are accepted by the spine", () => {
  for (const strategy of ["shadow", "tournament"]) {
    const r = runCli(["v2", "build", "race it", "--repo", REPO, "--strategy", strategy, "--json"]);
    const result = JSON.parse(r.stdout) as V2RunResult;
    assert.ok(result.outcome.kind === "failed");
    assert.equal(result.outcome.failure.category, "not_implemented", `${strategy} passed preflight`);
  }
});

test("v2 cli: `ikbi v2 --help` prints help and does NOT execute a run", () => {
  const r = runCli(["v2", "--help"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.includes('"journal"'), false, "help never enters the lifecycle");
});

test("v2 cli: v1's `ikbi build` is still registered and unchanged", () => {
  const r = runCli(["help", "--advanced"]);
  assert.equal(r.status, 0, r.stderr);
  for (const cmd of ["build", "fix", "repl", "doctor"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `\`ikbi ${cmd}\` is still listed`);
  }
  assert.match(r.stdout, /\bv2\b/, "and v2 appears in the advanced list");
});

test("v2 cli: the default help does NOT advertise the experimental command", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /^\s*v2\b/m, "v2 stays out of the golden-path help");
});
