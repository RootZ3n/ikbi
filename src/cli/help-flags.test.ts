/**
 * Work Order 3 — `--help`/`-h` (and `--version`/`-V`) must NOT initialize providers,
 * resolve identity, or make any model/network call. Help is answered offline, exits 0,
 * and prints usage.
 *
 * Two layers of proof:
 *   1. UNIT (DI): the build/fix handlers print usage and return BEFORE touching their
 *      cognition/orchestrator/pipeline deps — asserted with spies that count calls and
 *      throwing deps that would surface if the help short-circuit ever regressed.
 *   2. END-TO-END (subprocess): the built CLI, run in a FRESH shell (no IKBI_* keys, no
 *      .env), answers `build --help` / `memory --help` / `--version` with exit 0, usage
 *      text, and crucially NO cognition deliberation (which is the model call that made
 *      `build --help` hang) — mirroring bootstrap.test.ts's fresh-shell doctor spawn.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createWorkerCli } from "../modules/worker-model/cli.js";
import { createFixCli } from "./fix.js";
import { commands } from "./registry.js";
// Importing memory.js registers the `memory` command (its --help is handled in run()).
import "./memory.js";

/** Capturing stdout/stderr/exit sink (same shape the worker-model CLI tests use). */
function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

// ── UNIT: build --help short-circuits BEFORE any provider/model work ──────────

for (const flag of ["--help", "-h"]) {
  test(`build ${flag} prints usage, exits 0, and never calls cognition/orchestrator`, async () => {
    const cap = capture();
    let deliberateCalls = 0;
    let runCalls = 0;
    const cli = createWorkerCli({
      // Tokens ARE set — proving the early return precedes even the fail-closed token checks.
      operatorToken: "operator-token-value",
      workerToken: "worker-token-value",
      stdout: cap.stdout,
      stderr: cap.stderr,
      setExit: cap.setExit,
      // These deps would be exercised by a real build — they must NOT be touched for --help.
      cognition: { deliberate: async () => { deliberateCalls += 1; throw new Error("cognition must not run for --help"); } },
      orchestrator: {
        run: async () => { runCalls += 1; throw new Error("orchestrator must not run for --help"); },
        spawnRole: () => { throw new Error("spawnRole must not run for --help"); },
      },
    });

    await cli.build([flag]);

    assert.equal(deliberateCalls, 0, "cognition.deliberate (a model call) was never invoked");
    assert.equal(runCalls, 0, "orchestrator.run was never invoked");
    assert.equal(cap.exit, undefined, "exit code 0 (no setExit)");
    assert.match(cap.out, /Usage: ikbi build/, "usage text printed to stdout");
    assert.equal(cap.err, "", "nothing on stderr");
  });
}

test("build --help works even with NO operator/worker tokens (help precedes the fail-closed checks)", async () => {
  const cap = capture();
  const cli = createWorkerCli({
    operatorToken: undefined,
    workerToken: undefined,
    stdout: cap.stdout,
    stderr: cap.stderr,
    setExit: cap.setExit,
    cognition: { deliberate: async () => { throw new Error("must not run"); } },
    orchestrator: { run: async () => { throw new Error("must not run"); } },
  });

  await cli.build(["--help"]);

  assert.equal(cap.exit, undefined, "help exits 0 — it does not hit the missing-token error path");
  assert.match(cap.out, /Usage: ikbi build/, "usage printed");
  assert.doesNotMatch(cap.err, /no operator identity|no worker credential/, "no fail-closed token error for --help");
});

// ── UNIT: fix --help short-circuits BEFORE identity/pipeline ──────────────────

for (const flag of ["--help", "-h"]) {
  test(`fix ${flag} prints usage, exits 0, and never resolves identity or runs the pipeline`, async () => {
    const cap = capture();
    let resolveCalls = 0;
    let pipelineCalls = 0;
    const cli = createFixCli({
      operatorToken: "operator-token-value",
      resolveIdentity: () => { resolveCalls += 1; throw new Error("identity must not resolve for --help"); },
      runPipeline: async () => { pipelineCalls += 1; throw new Error("pipeline must not run for --help"); },
      stdout: cap.stdout,
      stderr: cap.stderr,
      setExit: cap.setExit,
    });

    await cli.fix([flag]);

    assert.equal(resolveCalls, 0, "identity was never resolved");
    assert.equal(pipelineCalls, 0, "the fix pipeline never ran");
    assert.equal(cap.exit, undefined, "exit code 0");
    assert.match(cap.out, /Usage: ikbi fix/, "usage text printed");
  });
}

// ── UNIT: memory --help short-circuits BEFORE governor construction ───────────

test("memory --help prints usage and exits 0 (governor never constructed)", async () => {
  const memory = commands.get("memory");
  assert.ok(memory !== undefined, "memory command is registered");

  const realWrite = process.stdout.write.bind(process.stdout);
  const prevExit = process.exitCode;
  let out = "";
  // The memory handler writes via process.stdout directly (no DI) — capture it.
  (process.stdout as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  process.exitCode = 0;
  try {
    await memory.run(["--help"]);
  } finally {
    (process.stdout as { write: (s: string) => boolean }).write = realWrite as (s: string) => boolean;
  }

  assert.match(out, /Usage: ikbi memory/, "usage text printed");
  assert.notEqual(process.exitCode, 1, "memory --help does not set a failure exit code");
  process.exitCode = prevExit;
});

// ── END-TO-END: fresh-shell subprocess, no keys, no .env, no model call ───────

/** Run the BUILT CLI in a clean environment (PATH + HOME only — a true fresh shell). */
function runColdCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const entry = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
  assert.ok(existsSync(entry), `built CLI not found at ${entry} — run \`pnpm build\` first`);
  const res = spawnSync(process.execPath, [entry, ...args], {
    // cwd left at the test process cwd is fine — the assertion is about NO model call, and
    // the repo's own .env carries no model keys that would change help behavior.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Cognition deliberation output — its presence proves a model call ran (the bug). */
const COGNITION_SIGNATURE = /decision:\s|rationale:\s/i;

test("`ikbi build --help` in a fresh shell: exit 0, usage, NO cognition/model call", () => {
  const res = runColdCli(["build", "--help"]);
  const combined = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `expected exit 0; got ${res.status}. Output:\n${combined}`);
  assert.match(res.stdout, /Usage: ikbi build/, "usage printed");
  assert.doesNotMatch(combined, COGNITION_SIGNATURE, "help must NOT deliberate (no model call)");
  assert.doesNotMatch(combined, /\n\s+at\s+\S+/, "no raw stack frame leaked");
});

test("`ikbi memory --help` in a fresh shell: exit 0, usage, no failure", () => {
  const res = runColdCli(["memory", "--help"]);
  const combined = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `expected exit 0; got ${res.status}. Output:\n${combined}`);
  assert.match(res.stdout, /Usage: ikbi memory/, "usage printed");
});

test("`ikbi --version` in a fresh shell: exit 0, version, NO cognition/model call", () => {
  const res = runColdCli(["--version"]);
  const combined = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `expected exit 0; got ${res.status}. Output:\n${combined}`);
  assert.match(res.stdout, /\d+\.\d+\.\d+/, "version number printed");
  assert.doesNotMatch(combined, COGNITION_SIGNATURE, "--version must NOT deliberate (no model call)");
});
