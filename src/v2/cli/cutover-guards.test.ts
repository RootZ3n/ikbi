/**
 * V2-018 CUTOVER STATIC GUARDS.
 *
 * These are SOURCE guards, not behavior tests: they read the CLI wiring and fail if the cutover is
 * ever quietly undone — a second production build engine, a duplicated call site, a V1 build path
 * reachable from `ikbi build`, or "experimental" creeping back onto the normal command. They are the
 * structural backstop behind the behavioral proofs in cli-subprocess.test.ts.
 */

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { commands } from "../../cli/registry.js";
import "./index.js"; // register `build` + `v2`
import "../../modules/worker-model/cli.js"; // register `legacy`

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const V2_CLI_SRC = read("./index.ts");
const WORKER_CLI_SRC = read("../../modules/worker-model/cli.ts");
const README = read("../../../README.md");

test("guard: exactly ONE production call site to runV2BuildSessionProduction in CLI build handling", () => {
  // THE INVARIANT IS ONE CALL SITE, not one spelling. The engine is now reached through an
  // injectable default — `(io.runSession ?? runV2BuildSessionProduction)(…)` — so a suite can drive
  // the advisory wiring around a build without rebuilding a repository. Both forms are counted, and
  // the total must still be one: `ikbi build` and `ikbi v2 build` funnel through the same place, and
  // a second engine would show up here as a second call however it were written.
  const direct = (V2_CLI_SRC.match(/(?<!\?\?\s)runV2BuildSessionProduction\s*\(/g) ?? []).length;
  const injected = (V2_CLI_SRC.match(/\?\?\s*runV2BuildSessionProduction\s*\)\s*\(/g) ?? []).length;
  assert.equal(direct + injected, 1, "both `ikbi build` and `ikbi v2 build` must funnel through ONE call site — no second engine");

  // AND THE SEAM MUST STAY A SEAM. A default that production can silently miss would let a build
  // run on an injected engine in production, which is the failure this guard exists to prevent.
  assert.equal(injected, 1, "the one call site must keep its production default");
  assert.match(V2_CLI_SRC, /readonly runSession\?:\s*typeof runV2BuildSessionProduction/, "the seam is typed to the production engine, so no other engine can be substituted");
});

test("guard: `ikbi build` is the CANONICAL golden-path command; `v2` is an advanced alias", () => {
  const build = commands.get("build");
  const v2 = commands.get("v2");
  assert.ok(build !== undefined && v2 !== undefined);
  assert.notEqual(build!.category, "advanced", "the daily driver is golden-path");
  assert.equal(v2!.category, "advanced", "the alias stays out of the golden help");
  assert.doesNotMatch(build!.summary, /EXPERIMENTAL/i, "the normal command is not experimental");
  assert.match(v2!.summary, /[Aa]lias for `ikbi build`/, "v2 declares itself an alias, not a second engine");
});

test("guard: the v1 build engine is NOT registered as a command AT ALL (V2-020 retirement)", () => {
  // V2-018 froze v1 behind `ikbi legacy build` as an emergency fallback for the qualification
  // window. V2-020 removed it: the audits are complete, and a second production build authority
  // an operator can type is exactly the hidden v1 authority this repository converged away from.
  // `legacy` survives ONLY as a tombstone that refuses — deleting it outright made `ikbi legacy
  // build "…"` fall through to the REPL and be read as a chat prompt, which is worse than a no.
  const legacy = commands.get("legacy");
  assert.ok(legacy !== undefined, "the retired name is claimed so it cannot be reinterpreted");
  assert.match(legacy!.summary ?? "", /RETIRED/, "it advertises itself as retired");
  // THE POINT: the tombstone builds no worker and reaches no orchestrator.
  assert.doesNotMatch(WORKER_CLI_SRC, /run:\s*\(argv\)\s*=>\s*\{\s*\n\s*const sub = argv\[0\];/, "the old dispatching body is gone");
  assert.doesNotMatch(WORKER_CLI_SRC, /live\.build\(/, "nothing dispatches into a live v1 build");
  assert.doesNotMatch(WORKER_CLI_SRC, /^const live = createWorkerCli\(\);$/m, "no module-level v1 build CLI is constructed");
  assert.doesNotMatch(WORKER_CLI_SRC, /registerCommand\(\{\s*\n\s*name:\s*"build"/, "worker-model registers no build command");
  for (const name of ["v1", "worker", "legacy-build"]) {
    assert.equal(commands.get(name), undefined, `no v1 build surface may be registered as \`${name}\``);
  }
});

test("guard: `build` is the ONE registered build command, and it is the v2 engine", () => {
  const build = commands.get("build");
  assert.ok(build !== undefined, "`ikbi build` exists");
  // The registered handler comes from the v2 CLI, which the guard above proves imports no v1 engine.
  assert.match(V2_CLI_SRC, /name:\s*"build"/, "the v2 CLI is what registers `build`");
});

test("guard: the canonical build handler does NOT import the v1 worker engine (no V1 promotion path)", () => {
  assert.doesNotMatch(V2_CLI_SRC, /from\s+["'][^"']*worker-model/, "the v2 CLI never pulls in the v1 build engine");
  assert.doesNotMatch(V2_CLI_SRC, /live\.build|createWorkerCli/, "no v1 build call reachable from `ikbi build`");
});

test("guard: the strategy DEFAULT is explicit `single` (tournament is never the default)", () => {
  // The default lives in preflight (`candidateStrategy` defaults to "single"); the CLI must not
  // hard-code a multi-candidate default.
  assert.doesNotMatch(V2_CLI_SRC, /candidateStrategy:\s*["'](shadow|tournament)["']/, "no non-single default in the CLI");
});

test("guard: the README documents `ikbi build` (not `ikbi v2 build`) as the canonical command", () => {
  assert.match(README, /ikbi build\b/, "README shows the canonical command");
  assert.doesNotMatch(README, /`ikbi v2 build`.*(?:daily|canonical|normal|primary)/i, "README does not present the alias as the primary command");
});

// ── V2-019/MEDIUM-01: the hermetic test-env opt-in stays a TEST concern ──────

test("guard: the synthetic dev-key opt-in is TEST-ONLY — no product module imports it", () => {
  // `src/v2/test-env.ts` mutates process.env, so it must never be reachable from shipped runtime.
  // Product code proving itself with a test helper's environment would be exactly the kind of
  // quiet weakening this guard exists to prevent.
  const v2Root = fileURLToPath(new URL("..", import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue; // tests are the sanctioned importer
      if (abs === join(v2Root, "test-env.ts")) continue;
      // The subprocess fixtures are test infrastructure, not product runtime.
      if (/(fixture-repo|fake-provider-server|session-json)\.ts$/.test(entry.name)) continue;
      if (/\btest-env\.js\b/.test(readFileSync(abs, "utf8"))) offenders.push(relative(v2Root, abs));
    }
  };
  walk(v2Root);
  assert.deepEqual(offenders, [], "only *.test.ts may import the dev-key opt-in");
});

test("guard: the opt-in never weakens production config, and yields to a real operator value", () => {
  const src = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "test-env.ts"), "utf8");
  // `??=` means an operator's real setting always wins; a bare `=` would override it.
  assert.match(src, /process\.env\.IKBI_ALLOW_INSECURE_DEV_KEYS \?\?= "true";/, "the opt-in must not clobber a real value");
  assert.doesNotMatch(src, /process\.env\.IKBI_ALLOW_INSECURE_DEV_KEYS\s*=\s*"/, "no unconditional assignment");
  // The FIX is scoped to tests: core config keeps its refusal.
  const config = readFileSync(fileURLToPath(new URL("../../core/config.ts", import.meta.url)), "utf8");
  assert.match(config, /Refusing to start with insecure default trust keys/, "production still fails closed on default keys");
  assert.match(config, /parseBool\(env\.IKBI_ALLOW_INSECURE_DEV_KEYS, false\)/, "the default is still FALSE in production config");
});

test("guard: the v2 CLI subprocess suite injects the dev-key opt-in EXPLICITLY into its child env", () => {
  const src = readFileSync(fileURLToPath(new URL("./cli-subprocess.test.ts", import.meta.url)), "utf8");
  assert.match(src, /HERMETIC_DEV_KEY_ENV/, "the sanitized child env opts in through the ONE shared owner");
  assert.doesNotMatch(src, /IKBI_ALLOW_INSECURE_DEV_KEYS:\s*"true"/, "no second, drifting copy of the flag");
});

// ── V2-020: the COMMAND MAP is what the docs say it is ──────────────────────

test("guard: no registered command other than the tombstone advertises a v1 build engine", () => {
  // The retirement is only real if it cannot be re-entered under a different name. Every registered
  // command is inspected: exactly one (`legacy`) may mention the v1 engine, and only to refuse.
  const offenders: string[] = [];
  for (const cmd of commands.all()) {
    if (cmd.name === "legacy") continue;
    const text = `${cmd.summary ?? ""} ${cmd.usage ?? ""}`;
    if (/\bv1 build\b|\blegacy build\b|\bfrozen v1\b/i.test(text)) offenders.push(cmd.name);
  }
  assert.deepEqual(offenders, [], "no command may offer the retired v1 build engine");
});

test("guard: `ikbi run` is HONEST about driving the legacy engine", () => {
  // `run` is the one retained surface that still delegates to v1. It is kept for its external-agent
  // task-file contract, so the requirement is not that it be gone — it is that it never pretend to
  // be the canonical engine. Both the help entry and the source say so.
  const runSrc = readFileSync(fileURLToPath(new URL("../../cli/run.ts", import.meta.url)), "utf8");
  assert.match(runSrc, /LEGACY/, "run.ts declares its engine status");
  assert.match(runSrc, /createWorkerCli/, "and it is in fact the v1 delegate this guard is about");
  const help = readFileSync(fileURLToPath(new URL("../../cli/help-pages.ts", import.meta.url)), "utf8");
  assert.match(help, /LEGACY v1 worker\/orchestrator/, "the help page names the engine plainly");
});

test("guard: the HTTP task service cannot start the retired v1 build engine", () => {
  const svc = readFileSync(fileURLToPath(new URL("../../server/task-service.ts", import.meta.url)), "utf8");
  const body = svc.slice(svc.indexOf("private async liveRunBuild"));
  const fn = body.slice(0, body.indexOf("\n  }\n") + 4);
  assert.doesNotMatch(fn, /createProductionWorker/, "no v1 worker is constructed over HTTP");
  assert.match(fn, /throw new Error/, "the endpoint fails closed");
  assert.match(fn, /ikbi build/, "and points at the canonical engine");
});
