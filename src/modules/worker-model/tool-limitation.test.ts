/**
 * ikbi worker-model — TOOL_LIMITATION detection.
 *
 * When a verification tool fails because it can't parse modern syntax (not because
 * the project is broken), the verifier should classify it as TOOL_LIMITATION, not PROJECT_RED.
 * This matters for Godot (gdtoolkit can't parse async func), Python (pylint can't parse match/case),
 * and any future tool that lags behind the language it's checking.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mapExec } from "./checks.js";

function fakeExecResult(exitCode: number, stdoutTail: string, stderrTail?: string) {
  return { executed: true, exitCode, stdoutTail, stderrTail: stderrTail ?? "", denied: false };
}

test("mapExec: gdtoolkit async parser failure → toolLimitation", () => {
  const output = `async func player_attack_action():\n^\n\nUnexpected token Token('NAME', 'async') at line 44, column 1.\nExpected one of: \n\t* FUNC\n\t* VAR\n\t* SIGNAL\nFailure: 1 problem found`;
  const { check } = mapExec("gdlint", "gdlint scripts/", fakeExecResult(1, output), output);
  assert.equal(check.exitCode, 1, "non-zero exit");
  assert.ok(check.toolLimitation !== undefined, "should detect tool limitation");
  assert.match(check.toolLimitation!.reason, /async func/, "reason mentions async func");
});

test("mapExec: gdtoolkit generic parser failure → toolLimitation", () => {
  const output = `Unexpected token Token('AT', '@') at line 10.\nExpected one of:\n\t* FUNC\nFailure: 1 problem found`;
  const { check } = mapExec("gdlint", "gdlint scripts/", fakeExecResult(1, output), output);
  assert.ok(check.toolLimitation !== undefined, "should detect tool limitation");
});

test("mapExec: real lint failure (trailing whitespace) → NO toolLimitation", () => {
  const output = `scripts/combat.gd:33: Error: Trailing whitespace(s) (trailing-whitespace)\nFailure: 1 problem found`;
  const { check } = mapExec("gdlint", "gdlint scripts/", fakeExecResult(1, output), output);
  assert.equal(check.toolLimitation, undefined, "real lint issues are NOT tool limitations");
});

test("mapExec: passing check → NO toolLimitation", () => {
  const output = `0 problems found`;
  const { check } = mapExec("gdlint", "gdlint scripts/", fakeExecResult(0, output), output);
  assert.equal(check.toolLimitation, undefined, "passing checks have no tool limitation");
});

test("mapExec: non-gdtoolkit failure → NO toolLimitation", () => {
  const output = `Error: syntax error at line 5`;
  const { check } = mapExec("node --test", "node --test", fakeExecResult(1, output), output);
  assert.equal(check.toolLimitation, undefined, "non-gdtoolkit failures are not tool limitations");
});

test("mapExec: tool crash (Traceback) → toolLimitation", () => {
  const output = `Traceback (most recent call last):\n  File "/usr/bin/gdlint", line 1\nRuntimeError: internal parser error`;
  const { check } = mapExec("gdlint", "gdlint scripts/", fakeExecResult(1, output), output);
  assert.ok(check.toolLimitation !== undefined, "tool crash is a tool limitation");
  assert.match(check.toolLimitation!.reason, /crashed/, "reason mentions crash");
});
