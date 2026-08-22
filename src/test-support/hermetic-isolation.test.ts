/**
 * A SANITIZED CHILD MUST STAY SANITIZED.
 *
 * `hermetic-env.test.ts` pins the trust material. This pins the other half of the same problem,
 * which that commit left open: the suites hand their children a deliberately minimal environment,
 * and `autoLoadDotEnv` then refilled it from `<project-root>/.env` — the operator's real provider
 * keys, their governed-exec allowlist, their gate-wall bypass. The child had no `NODE_TEST_CONTEXT`
 * (node:test sets it in ITS subprocesses, not in a grandchild the test spawns), and the path was
 * resolved from the config module's own project root, so running the child from another directory
 * did not help either.
 *
 * Measured before the fix: a child built exactly the way the hermetic suites build one saw 10
 * operator credentials, including four live provider API keys and IKBI_GATE_WALL_BYPASS.
 *
 * These tests use hostile literal values, never a helper that happens to produce a clean env.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  HERMETIC_DEV_KEY_ENV,
  hermeticChildEnv,
  isCredentialShapedEnvName,
} from "./hermetic-env.js";

function projectRoot(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate the project root");
}
const ROOT = projectRoot();
const CONFIG_JS = join(ROOT, "dist", "core", "config.js");

/** Names a real `.env` in this repository carries. Presence alone is the failure. */
const OPERATOR_SECRET_NAMES = [
  "IKBI_ANTHROPIC_API_KEY",
  "IKBI_OPENAI_API_KEY",
  "IKBI_DEEPSEEK_API_KEY",
  "IKBI_MIMO_API_KEY",
  "IKBI_OPERATOR_TOKEN",
  "IKBI_API_TOKEN",
  "IKBI_WORKER_TOKEN",
  "IKBI_GATE_WALL_BYPASS",
  "IKBI_GOVERNED_EXEC_ALLOWLIST",
  "IKBI_EGRESS_ALLOWLIST",
];

/**
 * Import the config module in a child and report which watched names are SET. Presence only —
 * a test that printed a value would put the operator's key in CI output, which is the very
 * failure being guarded against.
 */
function namesVisibleToChild(env: Record<string, string>, cwd: string): string[] {
  const probe =
    `await import(${JSON.stringify(CONFIG_JS)});` +
    `const w=${JSON.stringify(OPERATOR_SECRET_NAMES)};` +
    `console.log(JSON.stringify(w.filter(k=>typeof process.env[k]==="string"&&process.env[k].length>0)));`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  const line = res.stdout.trim().split("\n").pop() ?? "[]";
  try {
    return JSON.parse(line) as string[];
  } catch {
    throw new Error(`probe did not report: ${res.stdout}\n${res.stderr}`);
  }
}

test("a hermetic child reads NO operator credential from the repository .env", (t) => {
  if (!existsSync(CONFIG_JS)) return t.skip("dist not built");
  if (!existsSync(join(ROOT, ".env"))) return t.skip("no .env in this checkout — nothing to leak");

  // Exactly the environment the hermetic suites hand a spawned CLI.
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...HERMETIC_DEV_KEY_ENV };
  const seen = namesVisibleToChild(env, mkdtempSync(join(tmpdir(), "ikbi-herm-")));
  assert.deepEqual(seen, [], `sanitized child was refilled from .env with: ${seen.join(", ")}`);
});

test("the .env autoload is blocked by module path, not by cwd", (t) => {
  if (!existsSync(CONFIG_JS)) return t.skip("dist not built");
  if (!existsSync(join(ROOT, ".env"))) return t.skip("no .env in this checkout");

  // The original leak resolved <project-root>/.env from the CONFIG MODULE's location, so a child
  // started from an unrelated directory still got the operator's keys. Pin that running elsewhere
  // is not what saves us.
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...HERMETIC_DEV_KEY_ENV };
  const seen = namesVisibleToChild(env, tmpdir());
  assert.deepEqual(seen, [], `leaked from an unrelated cwd: ${seen.join(", ")}`);
});

test("a planted .env beside the child cannot reach it either", (t) => {
  if (!existsSync(CONFIG_JS)) return t.skip("dist not built");
  const dir = mkdtempSync(join(tmpdir(), "ikbi-planted-"));
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(
    join(dir, ".env"),
    ["IKBI_ANTHROPIC_API_KEY=planted-not-a-real-key", "IKBI_GATE_WALL_BYPASS=true"].join("\n"),
  );
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...HERMETIC_DEV_KEY_ENV };
  const seen = namesVisibleToChild(env, dir);
  assert.deepEqual(seen, [], `a planted .env reached a hermetic child: ${seen.join(", ")}`);
});

test("hermeticChildEnv strips a HOSTILE inherited environment", () => {
  // Hostile literals, not a constructor that yields something already clean.
  const hostile = {
    IKBI_ANTHROPIC_API_KEY: "sk-ant-hostile-inherited",
    IKBI_OPENAI_API_KEY: "sk-hostile-inherited",
    OPENAI_API_KEY: "sk-bare-name-hostile",
    SOME_VENDOR_SECRET: "hostile",
    IKBI_GATE_WALL_BYPASS: "true",
    IKBI_GOVERNED_EXEC_ALLOWLIST: "/bin/sh",
    IKBI_EGRESS_ALLOWLIST: "*",
  };
  const before = { ...process.env };
  try {
    Object.assign(process.env, hostile);
    const child = hermeticChildEnv();
    for (const name of Object.keys(hostile)) {
      assert.equal(child[name], undefined, `${name} survived into a hermetic child env`);
    }
    // It must still be usable: trust material present so the child can actually start.
    assert.equal(child.IKBI_HERMETIC_TEST, "1");
    assert.ok(child.IKBI_TRUST_HMAC_KEY);
    assert.ok(child.IKBI_IDENTITY_TOKEN_SALT);
  } finally {
    for (const name of Object.keys(hostile)) delete process.env[name];
    Object.assign(process.env, before);
  }
});

test("credential shapes are recognized by SHAPE, so a new provider is covered by default", () => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "IKBI_SOMENEWVENDOR_API_KEY",
    "X_SECRET",
    "SERVICE_TOKEN",
    "IKBI_TRUST_HMAC_KEY",
    "IKBI_IDENTITY_TOKEN_SALT",
    "IKBI_GATE_WALL_BYPASS",
  ]) {
    assert.equal(isCredentialShapedEnvName(name), true, `${name} should be treated as sensitive`);
  }
  for (const name of ["PATH", "HOME", "IKBI_STATE_ROOT", "IKBI_PORT", "IKBI_KEYBOARD_LAYOUT"]) {
    assert.equal(isCredentialShapedEnvName(name), false, `${name} is not a credential`);
  }
});

test("product runtime never imports the hermetic test material", () => {
  // The header of hermetic-env.ts asserts this in prose. Prose does not fail a build.
  const res = spawnSync(
    "grep",
    ["-rln", "--include=*.ts", "-e", "test-support/hermetic-env", join(ROOT, "src")],
    { encoding: "utf8" },
  );
  const importers = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(ROOT.length + 1))
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => !f.startsWith("src/test-support/"))
    // v2/test-env.ts is the documented v2 re-export seam, and is itself test-only.
    .filter((f) => f !== "src/v2/test-env.ts");
  assert.deepEqual(importers, [], `product runtime imports test-only trust material: ${importers}`);
});
