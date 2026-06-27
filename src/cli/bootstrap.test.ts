/**
 * HB-6 (audit): bootstrap — .env autoload + read-only info commands run on a fresh shell
 * (no raw stack trace). Unit tests for the pure helpers + an end-to-end `ikbi doctor` spawn
 * in a clean environment.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

import { CwdDotenvSecurityError, enableDevKeysForInfoCommand, INFO_COMMANDS, loadBootstrapEnv, loadDotenv } from "./bootstrap.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// ── loadDotenv (pure) ─────────────────────────────────────────────────────────

test("loadDotenv loads vars, ignores comments/blanks, strips quotes, supports `export`", () => {
  const dir = tmp("ikbi-env-");
  const path = join(dir, ".env");
  writeFileSync(path, ["# a comment", "", "IKBI_A=plain", 'IKBI_B="quoted value"', "export IKBI_C='single'", "garbage-no-eq", "=novalue"].join("\n"));
  const env: NodeJS.ProcessEnv = {};
  const set = loadDotenv(path, env);
  assert.deepEqual(set.sort(), ["IKBI_A", "IKBI_B", "IKBI_C"]);
  assert.equal(env.IKBI_A, "plain");
  assert.equal(env.IKBI_B, "quoted value");
  assert.equal(env.IKBI_C, "single");
});

test("loadDotenv NEVER overrides an already-set variable (the real env wins)", () => {
  const dir = tmp("ikbi-env-noover-");
  const path = join(dir, ".env");
  writeFileSync(path, "IKBI_X=from_dotenv\n");
  const env: NodeJS.ProcessEnv = { IKBI_X: "from_shell" };
  const set = loadDotenv(path, env);
  assert.equal(env.IKBI_X, "from_shell", "the shell value is preserved");
  assert.deepEqual(set, [], "nothing was set");
});

test("loadDotenv on a missing file is a no-op (never throws)", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(loadDotenv(join(tmp("ikbi-env-missing-"), ".env"), env), []);
});

test("loadBootstrapEnv loads install-root .env and ~/.ikbi/env from any cwd; cwd cannot override", () => {
  const root = tmp("ikbi-install-root-");
  const home = tmp("ikbi-home-");
  const cwd = tmp("ikbi-random-cwd-");
  writeFileSync(join(root, ".env"), "IKBI_A=from-root\nIKBI_SHARED=root\n");
  const ikbiHome = join(home, ".ikbi");
  writeFileSync(join(cwd, ".env"), "IKBI_SHARED=cwd\nIKBI_C=from-cwd\n");
  mkdirSync(ikbiHome, { recursive: true });
  writeFileSync(join(ikbiHome, "env"), "IKBI_B=from-home\nIKBI_SHARED=home\n");
  const env: NodeJS.ProcessEnv = {};
  loadBootstrapEnv(env, cwd, { installRoot: root, homeDir: home });
  assert.equal(env.IKBI_A, "from-root");
  assert.equal(env.IKBI_B, "from-home");
  assert.equal(env.IKBI_C, "from-cwd");
  assert.equal(env.IKBI_SHARED, "root", "higher-trust root env wins");
});

test("loadBootstrapEnv refuses security keys from cwd .env with a friendly error", () => {
  const root = tmp("ikbi-install-root-safe-");
  const home = tmp("ikbi-home-safe-");
  const cwd = tmp("ikbi-cwd-unsafe-");
  writeFileSync(join(cwd, ".env"), "IKBI_TRUST_HMAC_KEY=bad\nIKBI_OPERATOR_TOKEN=bad\n");
  assert.throws(
    () => loadBootstrapEnv({}, cwd, { installRoot: root, homeDir: home }),
    (e: unknown) => e instanceof CwdDotenvSecurityError && /Move them to ~\/\.ikbi\/env/.test(e.message),
  );
});

// ── enableDevKeysForInfoCommand (pure) ────────────────────────────────────────

test("info commands with no trust keys get the dev-keys opt-in (so config can load)", () => {
  for (const cmd of [...INFO_COMMANDS, undefined]) {
    const env: NodeJS.ProcessEnv = {};
    const enabled = enableDevKeysForInfoCommand(cmd === undefined ? [] : [cmd], env);
    assert.equal(enabled, true, `enabled for "${cmd ?? "(none)"}"`);
    assert.equal(env.IKBI_ALLOW_INSECURE_DEV_KEYS, "true");
  }
});

test("`--version`/`-V` (flag form) get the dev-keys opt-in so a fresh shell can print the version", () => {
  for (const argv of [["--version"], ["-V"]]) {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(enableDevKeysForInfoCommand(argv, env), true, `enabled for ${argv.join(" ")}`);
    assert.equal(env.IKBI_ALLOW_INSECURE_DEV_KEYS, "true");
  }
});

test("`<command> --help`/`--version` ANYWHERE in argv is treated as read-only info", () => {
  // The help/version flag follows a NON-info leading command (build/memory/fix) — a fresh-shell
  // stranger must still be able to read usage / the version without setting trust keys first.
  for (const argv of [["build", "--help"], ["memory", "--help"], ["fix", "-h"], ["build", "--version"]]) {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(enableDevKeysForInfoCommand(argv, env), true, `enabled for ${argv.join(" ")}`);
    assert.equal(env.IKBI_ALLOW_INSECURE_DEV_KEYS, "true");
  }
});

test("a real build/batch is NOT auto-opted-in (production guard stays)", () => {
  for (const cmd of ["build", "batch", "mcp", "undo"]) {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(enableDevKeysForInfoCommand([cmd], env), false, `${cmd} is not auto-opted-in`);
    assert.equal(env.IKBI_ALLOW_INSECURE_DEV_KEYS, undefined);
  }
});

test("the opt-in is skipped when the operator already chose, or keys are set", () => {
  const chosen: NodeJS.ProcessEnv = { IKBI_ALLOW_INSECURE_DEV_KEYS: "false" };
  assert.equal(enableDevKeysForInfoCommand(["doctor"], chosen), false);
  assert.equal(chosen.IKBI_ALLOW_INSECURE_DEV_KEYS, "false", "operator's explicit choice is untouched");

  const keyed: NodeJS.ProcessEnv = { IKBI_TRUST_HMAC_KEY: "k", IKBI_IDENTITY_TOKEN_SALT: "s" };
  assert.equal(enableDevKeysForInfoCommand(["doctor"], keyed), false, "real keys present ⇒ no opt-in");
});

// ── end-to-end: doctor on a fresh shell (no env, no .env) ─────────────────────

test("`ikbi doctor` runs in a fresh shell — exit 0, a helpful report, NO stack trace", () => {
  const entry = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
  assert.ok(existsSync(entry), `built CLI not found at ${entry} — run \`pnpm build\` first`);
  const freshCwd = tmp("ikbi-doctor-fresh-"); // no .env here
  // A CLEAN environment: only PATH + HOME, NO IKBI_* keys (a true fresh shell).
  const res = spawnSync(process.execPath, [entry, "doctor"], {
    cwd: freshCwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    encoding: "utf8",
  });
  const combined = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `doctor should exit 0; got ${res.status}. Output:\n${combined}`);
  assert.match(res.stdout, /REQUIRED FOR A BUILD/, "doctor printed its report");
  assert.match(res.stdout, /IKBI_OPERATOR_TOKEN/, "doctor tells you what's missing");
  // The original bug: a raw stack trace. There must be NO stack frame in the output.
  assert.doesNotMatch(combined, /\n\s+at\s+\S+/, "no raw stack frame leaked");
  assert.ok(!combined.includes("Refusing to start with insecure default trust keys"), "no fatal config throw");
});
