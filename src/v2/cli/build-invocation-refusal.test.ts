/**
 * INVOCATION REFUSAL — the canonical `ikbi build` argument contract (DD-01).
 *
 * THE DEFECT THIS PINS. `parseV2Args` used to DISCARD any token it did not recognize and keep
 * walking. Two silent failures fell out of that, and both were demonstrated against the built
 * CLI before this was written:
 *
 *   1. `ikbi build "<goal>" --dry-run` — an option that does not exist — parsed "cleanly" and the
 *      run PUBLISHED to the operator's branch. The operator asked for a preview and got a
 *      commit. A safety flag that silently does nothing is worse than no flag at all, because it
 *      buys confidence it cannot honor.
 *   2. `ikbi build "set widget to 2" --strategyy shadow` — one typo — dropped the option and
 *      folded its VALUE into the goal. The engine then built toward "set widget to 2 shadow".
 *      The operator's task was rewritten and nothing said so.
 *
 * Both are fail-OPEN defaults in an engine whose stated rule is fail-closed. The contract here is
 * that an invocation ikbi cannot read is REFUSED before anything is constructed — no provider
 * reached, no workspace allocated, no repository touched — with exit 2 and the offending token
 * named.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILD_USAGE, V2_USAGE, parseV2Args, runBuildCli, runV2Cli } from "./index.js";

/** Collect stderr and the exit code without touching the real process streams. */
function capture() {
  let text = "";
  return { stderr: (s: string) => { text += s; }, read: () => text };
}

// ── the parser ──────────────────────────────────────────────────────────────

test("DD-01: an unknown option is a REJECTION, not a dropped token", () => {
  const a = parseV2Args(["build", "set widget to 2", "--dry-run"], "/cwd");
  assert.equal(a.rejection, 'unknown option "--dry-run"');
});

test("DD-01: a typo'd option does NOT fold its value into the goal", () => {
  const a = parseV2Args(["build", "set widget to 2", "--strategyy", "shadow"], "/cwd");
  assert.notEqual(a.rejection, undefined, "the typo must be refused");
  assert.ok(!a.goal.includes("shadow"), `the goal was rewritten: ${a.goal}`);
});

test("DD-01: a known option missing its value is a rejection", () => {
  assert.equal(parseV2Args(["build", "goal", "--repo"], "/cwd").rejection, 'option "--repo" requires a value');
  assert.equal(parseV2Args(["build", "goal", "--profile"], "/cwd").rejection, 'option "--profile" requires a value');
});

test("DD-01: a known option must not swallow the NEXT option as its value", () => {
  const a = parseV2Args(["build", "goal", "--repo", "--json"], "/cwd");
  assert.equal(a.rejection, 'option "--repo" requires a value');
  assert.equal(a.repo, "/cwd", "the cwd default must survive a refused --repo");
});

test("DD-01: the FIRST problem is the one reported (a refusal is not a list)", () => {
  const a = parseV2Args(["build", "goal", "--nope", "--alsonope"], "/cwd");
  assert.equal(a.rejection, 'unknown option "--nope"');
});

test("DD-01: `--` ends option parsing so a dash-leading goal word gets through", () => {
  const a = parseV2Args(["build", "--", "--not-an-option", "words"], "/cwd");
  assert.equal(a.rejection, undefined);
  assert.equal(a.goal, "--not-an-option words");
});

test("DD-01: a clean invocation still parses exactly as before (no regression)", () => {
  const a = parseV2Args(["build", "make", "the", "thing", "--repo", "/r", "--strategy", "tournament", "--profile", "cheap", "--json"], "/cwd");
  assert.equal(a.rejection, undefined);
  assert.equal(a.goal, "make the thing");
  assert.equal(a.repo, "/r");
  assert.equal(a.strategy, "tournament");
  assert.equal(a.profile, "cheap");
  assert.equal(a.json, true);
});

// ── the command handlers: refuse BEFORE constructing anything ───────────────

test("DD-01: `ikbi build` refuses an unknown option with exit 2 and builds NOTHING", async () => {
  const cap = capture();
  // No io.transport / io.workspaces are supplied: if the handler got as far as constructing the
  // session it would reach the real runtime, so a clean return of 2 is itself the proof it did not.
  const code = await runBuildCli(["set widget to 2", "--dry-run"], { stderr: cap.stderr, cwd: "/cwd" });
  assert.equal(code, 2);
  assert.match(cap.read(), /unknown option "--dry-run"/);
  assert.ok(cap.read().includes(BUILD_USAGE), "the usage line must be shown with the refusal");
});

test("DD-01: `ikbi v2 build` refuses the same way, naming its own usage", async () => {
  const cap = capture();
  const code = await runV2Cli(["build", "--allow-repo-wide", "goal", "--bogus"], { stderr: cap.stderr, cwd: "/cwd" });
  assert.equal(code, 2);
  assert.match(cap.read(), /unknown option "--bogus"/);
  assert.ok(cap.read().includes(V2_USAGE));
});

test("DD-01: the refusal names the option, so the operator can see the typo", async () => {
  const cap = capture();
  await runBuildCli(["set widget to 2", "--strategyy", "shadow"], { stderr: cap.stderr, cwd: "/cwd" });
  assert.match(cap.read(), /--strategyy/, "the exact token the operator typed must appear");
});
