/*
  THE CHECK WORKING DIRECTORY.

  A repository whose manifest lives in a subdirectory could not express a runnable check
  at all. Ofi's app is in `frontend/`, so the checks declared for its first real
  qualification were `npm --prefix frontend ...` — and every one of them was refused in
  4ms by execution policy, because `--prefix` is a worktree-redirect flag that both moves
  the process and hides the subcommand from the script-run parse. The exam was impossible
  from the start and nothing said so until a run finally reached verification.

  The fix is a first-class, validated, containment-checked directory rather than a hole in
  the flag policy. These tests pin both halves: the new field works, and the old refusal
  stays exactly where it was.
*/

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeCheckCwd, parseChecksEnv } from "./index.js";
import { commandPolicyDenyReason } from "../execution-policy/risk.js";

/* ── Canonicalization ────────────────────────────────────────────────────── */

test("check cwd: absent means the repository root", () => {
  const r = normalizeCheckCwd(undefined);
  assert.ok(r.ok);
  assert.equal(r.cwd, undefined);
});

test("check cwd: a plain subdirectory is kept verbatim", () => {
  for (const raw of ["frontend", "packages/web", "apps/api/service"]) {
    const r = normalizeCheckCwd(raw);
    assert.ok(r.ok, raw);
    assert.equal(r.cwd, raw);
  }
});

test("check cwd: `.` and `./` normalize to the root, not to a literal dot", () => {
  /* Same meaning, therefore same identity and same hash. */
  for (const raw of [".", "./", "./."]) {
    const r = normalizeCheckCwd(raw);
    assert.ok(r.ok, raw);
    assert.equal(r.cwd, undefined, raw);
  }
});

test("check cwd: redundant separators and leading ./ are canonicalized", () => {
  for (const [raw, want] of [["./frontend", "frontend"], ["frontend/", "frontend"], ["packages//web", "packages/web"]] as const) {
    const r = normalizeCheckCwd(raw);
    assert.ok(r.ok, raw);
    assert.equal(r.cwd, want, raw);
  }
});

test("check cwd: `..` escape is REFUSED, never sanitized", () => {
  /*
    Refused rather than stripped. Quietly turning `../../etc` into `etc` would leave an
    operator believing a check ran somewhere it did not.
  */
  for (const raw of ["..", "../outside", "frontend/../..", "a/../../b", "./../x"]) {
    const r = normalizeCheckCwd(raw);
    assert.equal(r.ok, false, `${raw} must be refused`);
    if (!r.ok) assert.match(r.reason, /escapes the repository/);
  }
});

test("check cwd: absolute paths are refused", () => {
  for (const raw of ["/etc", "/", "/home/zen/repo/frontend", "C:/windows", "c:\\\\windows"]) {
    assert.equal(normalizeCheckCwd(raw).ok, false, `${raw} must be refused`);
  }
});

test("check cwd: NUL, empty and backslashes are refused", () => {
  assert.equal(normalizeCheckCwd("").ok, false, "empty");
  assert.equal(normalizeCheckCwd("   ").ok, false, "whitespace only");
  assert.equal(normalizeCheckCwd("front\\0end").ok, false, "NUL");
  assert.equal(normalizeCheckCwd("packages\\\\web").ok, false, "backslash separators are not portable");
});

test("check cwd: the refusal says what to do instead", () => {
  const empty = normalizeCheckCwd("");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /omit it for the repository root/);
});

/* ── IKBI_CHECKS parsing ─────────────────────────────────────────────────── */

test("check cwd: IKBI_CHECKS accepts a cwd and canonicalizes it", () => {
  const parsed = parseChecksEnv(JSON.stringify([
    { name: "frontend build", command: "npm", args: ["run", "build"], cwd: "./frontend" },
  ]));
  assert.ok(Array.isArray(parsed));
  assert.equal((parsed as { cwd?: string }[])[0]!.cwd, "frontend");
});

test("check cwd: a check with NO cwd still parses, unchanged", () => {
  /* Backwards compatibility: every existing operator config keeps working. */
  const parsed = parseChecksEnv(JSON.stringify([{ name: "test", command: "pnpm", args: ["test"] }]));
  assert.ok(Array.isArray(parsed));
  const c = (parsed as { name: string; command: string; args: string[]; cwd?: string }[])[0]!;
  assert.deepEqual({ name: c.name, command: c.command, args: c.args }, { name: "test", command: "pnpm", args: ["test"] });
  assert.equal(c.cwd, undefined, "and it carries no cwd key at all");
});

test("check cwd: a MALFORMED cwd fails the whole config, before any spend", () => {
  /*
    Refused at parse time — before a workspace is allocated and before a provider is paid.
    A bad directory is a configuration error, and the operator should hear about it from
    `doctor`, not from a receipt.
  */
  for (const bad of ["../escape", "/abs", "", 42]) {
    const raw = JSON.stringify([{ name: "x", command: "npm", args: ["run", "b"], cwd: bad }]);
    assert.equal(parseChecksEnv(raw), "malformed", `cwd ${JSON.stringify(bad)} must fail the config`);
  }
});

/* ── The flag policy this replaced stays exactly as it was ───────────────── */

test("check cwd: package-manager redirect flags are STILL refused", () => {
  /*
    THE regression that matters. The new field must not have arrived as a quiet relaxation
    of the flag policy — `--prefix` is refused for the verifier too, which is precisely
    why it needed replacing rather than exempting.
  */
  for (const flag of [["--prefix", "frontend", "run", "build"], ["--dir", "frontend", "test"], ["-C", "frontend", "test"], ["--cwd", "frontend", "test"]]) {
    for (const verifier of [true, false]) {
      const reason = commandPolicyDenyReason("npm", flag, { verifier });
      assert.ok(reason !== undefined, `npm ${flag.join(" ")} (verifier=${verifier}) must stay denied`);
      assert.match(reason, /redirect|worktree escape/i);
    }
  }
});

test("check cwd: an ordinary verifier script run is still allowed", () => {
  // The thing that always worked must keep working, or the exam breaks the other way.
  assert.equal(commandPolicyDenyReason("npm", ["run", "build"], { verifier: true }), undefined);
  assert.equal(commandPolicyDenyReason("pnpm", ["test"], { verifier: true }), undefined);
});

test("check cwd: a MODEL-initiated script run is still denied", () => {
  assert.ok(commandPolicyDenyReason("npm", ["run", "build"], { verifier: false }) !== undefined);
});
