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

test("a BLOCKED write in a read-only verify pass does not taint (benign, no effect)", () => {
  assert.equal(isPolicyViolation({ tool: "write_file", path: "src/x.ts", error: "write_scope is 'none' — read-only mode" }), false);
});

test("a new-file-only OVERWRITE attempt on an existing file still taints", () => {
  assert.equal(isPolicyViolation({ tool: "write_file", path: "src/x.ts", error: "write_scope is 'new_only' — cannot modify existing file" }), true);
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

test("a blocked builder attempt to run the project's TEST/CHECK command does NOT taint (benign self-verification)", () => {
  // Captured live from a multi-step Bokahli build: the builder reached for `pnpm test` to check its
  // own work; pnpm scripts are reserved for the verifier/check role, so it was blocked. That is
  // benign self-verification through the wrong tool (run_checks exists; the verifier runs the real
  // checks; nothing executed) — it must NOT discard an otherwise-verified build.
  const err = "pnpm script execution is allowed only for verifier/check runs";
  assert.equal(isPolicyViolation({ tool: "terminal", error: err, path: "pnpm test" }), false, "pnpm test");
  assert.equal(isPolicyViolation({ tool: "terminal", error: err, path: "pnpm run typecheck" }), false, "typecheck");
  assert.equal(isPolicyViolation({ tool: "terminal", error: err, path: "pnpm run lint" }), false, "lint");
  assert.equal(isPolicyViolation({ tool: "terminal", error: err, path: "pnpm build" }), false, "build");
});

test("a blocked builder pnpm script that is NOT a check/test/build script STILL taints", () => {
  // A non-verification pnpm script (deploy/publish/postinstall/arbitrary) is a genuine red flag —
  // it could run arbitrary code — so a blocked attempt still taints even though confinement held.
  const err = "pnpm script execution is allowed only for verifier/check runs";
  assert.equal(isPolicyViolation({ tool: "terminal", error: err, path: "pnpm run deploy" }), true, "deploy");
  assert.equal(isPolicyViolation({ tool: "terminal", error: err, path: "pnpm publish" }), true, "publish");
  assert.equal(isPolicyViolation({ tool: "terminal", error: err, path: "pnpm run seed-db" }), true, "seed-db");
});

test("a plain tool-format error does not taint", () => {
  assert.equal(isPolicyViolation({ tool: "write_file", error: "malformed arguments (not valid JSON)" }), false);
  assert.equal(isPolicyViolation({ tool: "frobnicate", error: 'unknown tool "frobnicate"' }), false);
});
