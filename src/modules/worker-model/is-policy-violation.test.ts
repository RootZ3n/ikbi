/**
 * isPolicyViolation — decides whether a REJECTED builder tool call taints promotion (discards an
 * otherwise-verified build). Recalibrated for the trusted-local context: a bare allowlist denial
 * BLOCKED the command (confinement held, no effect), so a benign dev/build tool the model improvised
 * must NOT discard verified-clean work — but a reach for the network / a raw shell / privilege
 * escalation / a destructive tool STILL taints even when blocked, and genuine boundary breaches
 * (scope escape, write-scope, dependency-dir, "only for verifier/check") always taint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isPolicyViolation } from "./builder.js";
import type { ToolCallError } from "./builder-tools/confine.js";

const denied = (bin: string): ToolCallError => ({ tool: "terminal", error: `binary '${bin}' is not on the allowlist (denied)` });

test("a blocked BENIGN dev/build tool does not taint (verified-clean work survives)", () => {
  for (const bin of ["tsc", "yarn", "npx", "make", "eslint", "prettier", "tsx", "vitest"]) {
    assert.equal(isPolicyViolation(denied(bin)), false, `${bin} should be benign`);
  }
});

test("a blocked read-only probe does not taint", () => {
  for (const bin of ["which", "env", "pwd", "whoami"]) {
    assert.equal(isPolicyViolation(denied(bin)), false, `${bin} should be benign`);
  }
});

test("a blocked DANGEROUS binary still taints (network / shell / privilege / destructive)", () => {
  for (const bin of ["curl", "wget", "ssh", "nc", "bash", "sh", "sudo", "su", "rm", "dd", "chmod", "systemctl"]) {
    assert.equal(isPolicyViolation(denied(bin)), true, `${bin} must taint`);
  }
});

test("genuine boundary breaches always taint", () => {
  assert.equal(isPolicyViolation({ tool: "write_file", error: 'path "../x" escapes the worktree' }), true);
  assert.equal(isPolicyViolation({ tool: "write_file", error: "WRITE SCOPE VIOLATION: outside declared scope" }), true);
  assert.equal(isPolicyViolation({ tool: "write_file", error: "write to dependency directory node_modules is not allowed" }), true);
  assert.equal(isPolicyViolation({ tool: "terminal", error: "terminal is only for verifier/check purposes" }), true);
});

test("a path-confinement /denied/ that is NOT a bare allowlist-binary denial still taints", () => {
  assert.equal(isPolicyViolation({ tool: "terminal", error: "egress denied: attempted network connection" }), true);
});

test("a plain tool-format error does not taint", () => {
  assert.equal(isPolicyViolation({ tool: "write_file", error: "malformed arguments (not valid JSON)" }), false);
  assert.equal(isPolicyViolation({ tool: "frobnicate", error: 'unknown tool "frobnicate"' }), false);
});
