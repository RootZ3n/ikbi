/**
 * V2-018 CUTOVER STATIC GUARDS.
 *
 * These are SOURCE guards, not behavior tests: they read the CLI wiring and fail if the cutover is
 * ever quietly undone — a second production build engine, a duplicated call site, a V1 build path
 * reachable from `ikbi build`, or "experimental" creeping back onto the normal command. They are the
 * structural backstop behind the behavioral proofs in cli-subprocess.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const calls = (V2_CLI_SRC.match(/runV2BuildSessionProduction\s*\(/g) ?? []).length;
  assert.equal(calls, 1, "both `ikbi build` and `ikbi v2 build` must funnel through ONE call site — no second engine");
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

test("guard: the frozen v1 pipeline is registered ONLY under the `legacy` namespace", () => {
  assert.ok(commands.get("legacy") !== undefined, "v1 is reachable as `ikbi legacy build`");
  // worker-model registers `legacy`, never `build`.
  assert.match(WORKER_CLI_SRC, /name:\s*"legacy"/, "worker-model registers legacy");
  assert.doesNotMatch(WORKER_CLI_SRC, /registerCommand\(\{\s*\n\s*name:\s*"build"/, "worker-model no longer registers build");
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
