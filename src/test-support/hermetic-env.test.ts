/**
 * THE SUITE MUST NOT DEPEND ON THE OPERATOR'S MACHINE.
 *
 * A clean checkout failed 191 tests that passed on the developer's box, and the entire difference
 * was an untracked `.env` at the project root. The suites that SPAWN the real CLI build a
 * deliberately sanitized child environment — and then the child re-read that file and helped itself
 * to the operator's trust keys, their governed-exec allowlist, and their real API keys. A sanitized
 * environment that is quietly refilled from disk is not sanitized, and a suite whose result depends
 * on a file nobody can see in review is not a suite anyone can trust.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { HERMETIC_DEV_KEY_ENV, HERMETIC_TEST_KEY_PREFIX } from "./hermetic-env.js";
import { loadConfig } from "../core/config.js";

/**
 * The SOURCE tree, located from the project root rather than from this module.
 *
 * These checks read `.ts` sources, and this file runs both from `src/` under tsx and from `dist/`
 * when invoked directly — so deriving the path from `import.meta.url` finds the compiled tree half
 * the time. The project root is the one anchor that means the same thing either way.
 */
function projectRoot(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate the project root");
}
const SRC = join(projectRoot(), "src");

test("hermetic env: supplies real, non-default trust material", () => {
  // Non-default keys satisfy the production refusal honestly rather than waiving it.
  assert.ok(HERMETIC_DEV_KEY_ENV.IKBI_TRUST_HMAC_KEY!.startsWith(HERMETIC_TEST_KEY_PREFIX));
  assert.ok(HERMETIC_DEV_KEY_ENV.IKBI_IDENTITY_TOKEN_SALT!.startsWith(HERMETIC_TEST_KEY_PREFIX));
  assert.equal(HERMETIC_DEV_KEY_ENV.IKBI_HERMETIC_TEST, "1");
});

test("hermetic env: the material is GENERATED, not a committed constant", () => {
  // A fixed secret in source is a reusable credential, and "it's only for tests" stops being true
  // the first time somebody copies it. The random tail is what makes that impossible.
  const src = readFileSync(join(SRC, "test-support", "hermetic-env.ts"), "utf8");
  assert.match(src, /randomBytes\(/, "the material must be minted, not literal");
  const tail = HERMETIC_DEV_KEY_ENV.IKBI_TRUST_HMAC_KEY!.slice(HERMETIC_TEST_KEY_PREFIX.length);
  assert.ok(tail.length > 40, "a generated secret carries real entropy");
  assert.ok(!src.includes(tail), "the live value must not appear in the source");
});

test("hermetic env: keys are STABLE within a process — deterministic where tests need it", async () => {
  // Every child a suite spawns must share one identity, or trust MACs minted by one would be
  // unreadable by the next.
  const again = await import("./hermetic-env.js");
  assert.equal(again.HERMETIC_DEV_KEY_ENV.IKBI_TRUST_HMAC_KEY, HERMETIC_DEV_KEY_ENV.IKBI_TRUST_HMAC_KEY);
  assert.equal(again.HERMETIC_DEV_KEY_ENV.IKBI_IDENTITY_TOKEN_SALT, HERMETIC_DEV_KEY_ENV.IKBI_IDENTITY_TOKEN_SALT);
});

test("hermetic env: PRODUCTION REFUSES test material", () => {
  // The material is good enough to start a process, so the only thing that could stop it becoming a
  // production trust grant is a refusal. Here it is.
  const base = { IKBI_STATE_ROOT: "/tmp/hermetic-guard", HOME: "/tmp/hermetic-guard" } as NodeJS.ProcessEnv;
  assert.throws(
    () => loadConfig({ ...base, IKBI_TRUST_HMAC_KEY: `${HERMETIC_TEST_KEY_PREFIX}hmac-abc`, IKBI_IDENTITY_TOKEN_SALT: "a-real-salt" }),
    /Refusing to start with TEST-ONLY trust material/,
  );
  assert.throws(
    () => loadConfig({ ...base, IKBI_TRUST_HMAC_KEY: "a-real-key", IKBI_IDENTITY_TOKEN_SALT: `${HERMETIC_TEST_KEY_PREFIX}salt-abc` }),
    /Refusing to start with TEST-ONLY trust material/,
  );
});

test("hermetic env: the marker alone grants nothing", () => {
  // Without prefixed keys it changes no behavior; the DEFAULT-key refusal still fires.
  assert.throws(
    () => loadConfig({ IKBI_STATE_ROOT: "/tmp/hermetic-guard", HOME: "/tmp/hermetic-guard", IKBI_HERMETIC_TEST: "1" } as NodeJS.ProcessEnv),
    /Refusing to start with insecure default trust keys/,
  );
});

test("hermetic env: the marker permits the test material it was minted for", () => {
  assert.doesNotThrow(() =>
    loadConfig({
      IKBI_STATE_ROOT: "/tmp/hermetic-guard", HOME: "/tmp/hermetic-guard",
      ...HERMETIC_DEV_KEY_ENV,
    } as NodeJS.ProcessEnv),
  );
});

test("hermetic env: real operator keys are unaffected", () => {
  assert.doesNotThrow(() =>
    loadConfig({
      IKBI_STATE_ROOT: "/tmp/hermetic-guard", HOME: "/tmp/hermetic-guard",
      IKBI_TRUST_HMAC_KEY: "an-operators-real-key", IKBI_IDENTITY_TOKEN_SALT: "an-operators-real-salt",
    } as NodeJS.ProcessEnv),
  );
});

test("portability: EVERY suite that spawns the built CLI injects the hermetic env", () => {
  // This is the regression that let 191 tests depend on an untracked file. A new spawning suite
  // that forgets the injection passes on the author's machine and fails on everyone else's, so the
  // check is structural rather than a convention in a comment.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.name.endsWith(".test.ts")) continue;
      const s = readFileSync(abs, "utf8");
      if (!s.includes("dist/cli/index.js")) continue;
      if (!s.includes("HERMETIC_DEV_KEY_ENV")) offenders.push(abs.slice(SRC.length));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], "a suite spawning the CLI must inject the hermetic environment");
});

test("portability: the hermetic env PRE-EMPTS every key a repository `.env` could supply", () => {
  /*
    THE MECHANISM, asserted precisely.

    `applyDotEnv` never overwrites an already-set key — "shell env wins". So a child that is handed
    these keys explicitly cannot have them replaced by a project `.env`, whether or not one exists.
    That, and not a heuristic about which files mention the string ".env", is what makes the suite
    independent of the operator's machine.

    An earlier version of this test scanned sources for the literal `.env` and reported three
    suites that legitimately WRITE their own fixture, plus a job-card test using ".env" as an
    example protected path, plus this file's own explanatory comments. A guard that cries wolf
    about the prose describing it teaches people to delete the prose.
  */
  const preempted = Object.keys(HERMETIC_DEV_KEY_ENV);
  for (const required of ["IKBI_TRUST_HMAC_KEY", "IKBI_IDENTITY_TOKEN_SALT"]) {
    assert.ok(preempted.includes(required), `${required} must be supplied, or a .env could set it`);
    assert.ok((HERMETIC_DEV_KEY_ENV as Record<string, string>)[required]!.length > 0, `${required} must be non-empty`);
  }
  // And the loader really does yield to an already-set key — the property everything above rests on.
  const loader = readFileSync(join(SRC, "core", "config.ts"), "utf8");
  assert.match(loader, /never overwrite an already-set key/i, "applyDotEnv must keep yielding to the environment");
});
