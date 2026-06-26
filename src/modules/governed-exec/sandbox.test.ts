/**
 * ikbi governed-exec sandbox — UNIT tests (F1).
 *
 * Pure tests for risk classification + bwrap argv construction + plan wrapping. No real subprocess
 * is spawned here (the actual OS-confinement is proven by sandbox-f1.test.ts, which runs bwrap when
 * available and asserts the fail-closed path when it is not). These tests never touch the host fs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyCommandRisk,
  buildBwrapArgs,
  wrapWithSandbox,
  detectSandbox,
  resetSandboxAvailabilityCache,
  type SandboxPlan,
} from "./sandbox.js";

test("classify: interpreters are always risky (execute arbitrary code)", () => {
  for (const cmd of ["node", "python3", "python", "tsx", "ts-node", "deno", "bun", "ruby", "perl", "php", "bash", "sh"]) {
    const r = classifyCommandRisk(cmd, ["script.x"]);
    assert.equal(r.risky, true, `${cmd} must be risky`);
    assert.equal(r.kind, "interpreter");
    assert.equal(r.needsNetwork, false);
  }
});

test("classify: a node SCRIPT (the F1 vector) is risky", () => {
  const r = classifyCommandRisk("node", ["write_escaped.js"]);
  assert.equal(r.risky, true);
  assert.equal(r.kind, "interpreter");
});

test("classify: absolute interpreter path is classified by basename", () => {
  const r = classifyCommandRisk("/home/u/.hermes/node/bin/node", ["s.js"]);
  assert.equal(r.risky, true);
  assert.equal(r.kind, "interpreter");
});

test("classify: package-manager INSTALL needs network; RUN/TEST does not", () => {
  for (const sub of ["install", "i", "add", "ci", "update", "fetch", "dlx"]) {
    const r = classifyCommandRisk("pnpm", [sub]);
    assert.equal(r.risky, true);
    assert.equal(r.kind, "package-install");
    assert.equal(r.needsNetwork, true, `pnpm ${sub} needs network`);
  }
  for (const sub of ["test", "run", "build", "start"]) {
    const r = classifyCommandRisk("pnpm", [sub]);
    assert.equal(r.risky, true);
    assert.equal(r.kind, "package-script");
    assert.equal(r.needsNetwork, false, `pnpm ${sub} must NOT get network`);
  }
});

test("classify: pip/poetry installs need network", () => {
  assert.equal(classifyCommandRisk("pip3", ["install", "requests"]).needsNetwork, true);
  assert.equal(classifyCommandRisk("pip", []).needsNetwork, true);
});

test("classify: toolchains (cargo/go/pytest/vitest) are risky", () => {
  assert.equal(classifyCommandRisk("cargo", ["test"]).kind, "toolchain");
  assert.equal(classifyCommandRisk("go", ["test", "./..."]).kind, "toolchain");
  assert.equal(classifyCommandRisk("pytest", []).risky, true);
  assert.equal(classifyCommandRisk("vitest", ["run"]).risky, true);
});

test("classify: write-capable coreutils are confined too (argv checks miss their writes)", () => {
  for (const cmd of ["cp", "mkdir", "dd", "tee", "mv", "rm", "ln", "sed"]) {
    assert.equal(classifyCommandRisk(cmd, ["x"]).risky, true, `${cmd} must be sandboxed`);
  }
});

test("classify: safe read/VCS commands are NOT risky (run unsandboxed)", () => {
  for (const cmd of ["git", "ls", "cat", "echo", "head", "tail", "wc", "grep", "find"]) {
    const r = classifyCommandRisk(cmd, ["x"]);
    assert.equal(r.risky, false, `${cmd} must be safe`);
    assert.equal(r.kind, "safe");
  }
});

test("buildBwrapArgs: host read-only, worktree writable, net denied by default, command at the end", () => {
  const plan: SandboxPlan = {
    mode: "bwrap",
    writableRoot: "/work/wt",
    cwd: "/work/wt",
    networkAllowed: false,
    risk: classifyCommandRisk("node", ["s.js"]),
  };
  const a = buildBwrapArgs(plan, "node", ["s.js"]);
  const s = a.join(" ");
  assert.match(s, /--ro-bind \/ \//, "entire host must be bound read-only");
  assert.match(s, /--tmpfs \/tmp/, "tmp must be an ephemeral tmpfs");
  assert.ok(a.includes("--unshare-all"), "all namespaces unshared (incl. network)");
  assert.ok(!a.includes("--share-net"), "network must NOT be shared when networkAllowed=false");
  // worktree bound writable
  const bi = a.indexOf("--bind");
  assert.ok(bi >= 0 && a[bi + 1] === "/work/wt" && a[bi + 2] === "/work/wt", "worktree bound read-write");
  // the actual command comes after the `--` separator
  const dash = a.indexOf("--");
  assert.ok(dash >= 0);
  assert.deepEqual(a.slice(dash + 1), ["node", "s.js"], "command + args follow the -- separator");
  // /tmp is an ephemeral tmpfs so an absolute /tmp/x escape is sandbox-private (not on the host).
  const ti = a.indexOf("--tmpfs");
  assert.ok(ti >= 0 && a[ti + 1] === "/tmp", "/tmp is a fresh tmpfs (ephemeral)");
  // HOME is left as the REAL (read-only) home — NOT isolated — so toolchains find their
  // packages/stores (pnpm store + deps check, python ~/.local, cargo registry). Writes still EROFS.
  assert.ok(!a.includes("HOME"), "HOME is not overridden — the real home is bound read-only for tool discovery");
});

test("buildBwrapArgs: --share-net is added ONLY when network is explicitly allowed", () => {
  const plan: SandboxPlan = { mode: "bwrap", writableRoot: "/w", networkAllowed: true, risk: classifyCommandRisk("pnpm", ["install"]) };
  assert.ok(buildBwrapArgs(plan, "pnpm", ["install"]).includes("--share-net"));
});

test("wrapWithSandbox: bwrap plan rewrites to `bwrap … -- cmd`; none/undefined passes through", () => {
  const plan: SandboxPlan = { mode: "bwrap", writableRoot: "/w", networkAllowed: false, risk: classifyCommandRisk("node", ["s.js"]) };
  const w = wrapWithSandbox(plan, "node", ["s.js"]);
  assert.equal(w.binary, "bwrap");
  assert.ok((w.args as string[]).includes("node"));

  const none = wrapWithSandbox({ mode: "none", networkAllowed: false, risk: classifyCommandRisk("git", []) }, "git", ["status"]);
  assert.equal(none.binary, "git");
  assert.deepEqual(none.args, ["status"]);
  const undef = wrapWithSandbox(undefined, "git", ["status"]);
  assert.equal(undef.binary, "git");
});

test("detectSandbox: caches an injected probe result", () => {
  resetSandboxAvailabilityCache();
  let calls = 0;
  const probe = () => { calls += 1; return { available: false as const, reason: "test" }; };
  const a = detectSandbox(probe);
  const b = detectSandbox(probe);
  assert.equal(a.available, false);
  assert.equal(b.reason, "test");
  assert.equal(calls, 1, "probe is cached after the first call");
  resetSandboxAvailabilityCache();
});
