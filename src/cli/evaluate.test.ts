/**
 * ikbi `evaluate` CLI tests — arg parsing, fixture compilation/loading, output, routing persistence.
 *
 * The harness itself is exercised in capability-harness.test.ts; here we inject `runHarness` so no
 * model is ever invoked and the tests are deterministic and offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CapabilityScorecard } from "../modules/worker-model/capability-harness.js";
import {
  createEvaluateCli,
  parseEvaluateArgs,
  compileFixture,
  loadFixtures,
  formatMarkdown,
  writeRoutingToProviders,
  type FixtureJson,
} from "./evaluate.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ikbi-eval-"));
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

function card(model: string, over: Partial<CapabilityScorecard> = {}): CapabilityScorecard {
  return {
    model,
    tool_call_reliability: 0.8,
    schema_reliability: 0.9,
    patch_parseability: 0.7,
    diff_minimality: 0.6,
    test_boundary_respect: 1,
    target_test_pass: 0.5,
    full_verification_pass: 0.5,
    repair_success_rate: 0.4,
    overclaiming_rate: 0.1,
    recommended_role: "agent_builder",
    routing_reason: "reliable tool agent",
    observations: [
      { fixture: "f1", mode: "agent", toolCallValid: true },
      { fixture: "f1", mode: "patch", patchParseable: true },
      { fixture: "f1", mode: "plan_patch", patchParseable: true },
      { fixture: "f1", mode: "repair", repairSuccess: true },
    ],
    ...over,
  };
}

const VALID_FIXTURE: FixtureJson = {
  name: "set-v-to-2",
  goal: "Change v from 1 to 2 in src/f.ts.",
  files: { "src/f.ts": "export const v = 1;\n" },
  targetFile: "src/f.ts",
  forbiddenFiles: ["src/f.test.ts"],
  repairVerifierOutput: "FAILED: v is not 2",
  oracle: {
    targetTest: { file: "src/f.ts", mustMatch: ["export const v = 2;"] },
    fullVerification: { file: "src/f.ts", mustMatch: ["export const v = 2;"], mustNotMatch: ["export const v = 1;"] },
  },
};

// ── Arg parsing ────────────────────────────────────────────────────────────────

test("parseEvaluateArgs: models / modes / flags", () => {
  const a = parseEvaluateArgs(["--models", "m1,m2", "--modes", "agent,patch", "--json", "--write-providers"], "default-builder");
  assert.deepEqual(a.models, ["m1", "m2"]);
  assert.deepEqual(a.modes, ["agent", "patch"]);
  assert.equal(a.json, true);
  assert.equal(a.writeProviders, true);
});

test("parseEvaluateArgs: defaults to the configured builder + all modes", () => {
  const a = parseEvaluateArgs([], "default-builder");
  assert.deepEqual(a.models, ["default-builder"]);
  assert.deepEqual(a.modes, ["agent", "patch", "plan_patch", "repair"]);
});

test("parseEvaluateArgs: invalid modes fall back to all modes", () => {
  const a = parseEvaluateArgs(["--modes", "bogus,nope"], "b");
  assert.deepEqual(a.modes, ["agent", "patch", "plan_patch", "repair"]);
});

test("parseEvaluateArgs: --max-extra-files parses a non-negative integer", () => {
  assert.equal(parseEvaluateArgs(["--max-extra-files", "2"], "b").maxExtraFiles, 2);
  assert.equal(parseEvaluateArgs(["--max-extra-files", "-1"], "b").maxExtraFiles, 0);
});

// ── Fixture compilation ─────────────────────────────────────────────────────────

test("compileFixture builds working oracles from regex specs", () => {
  const fx = compileFixture(VALID_FIXTURE);
  assert.equal(fx.name, "set-v-to-2");
  assert.deepEqual(fx.forbiddenFiles, ["src/f.test.ts"]);
  assert.equal(fx.targetTestPasses({ "src/f.ts": "export const v = 2;\n" }), true);
  assert.equal(fx.targetTestPasses({ "src/f.ts": "export const v = 1;\n" }), false);
  // fullVerification requires the new value AND the absence of the old one.
  assert.equal(fx.fullVerificationPasses({ "src/f.ts": "export const v = 2;\n" }), true);
  assert.equal(fx.fullVerificationPasses({ "src/f.ts": "export const v = 2;\nexport const v = 1;\n" }), false);
});

test("compileFixture rejects a malformed fixture", () => {
  assert.throws(() => compileFixture({ name: "x" }), /missing "goal"/);
  assert.throws(() => compileFixture({ name: "x", goal: "g", files: {}, targetFile: "a", repairVerifierOutput: "r", oracle: {} }), /oracle\./);
});

// ── Fixture loading ─────────────────────────────────────────────────────────────

test("loadFixtures: explicit --fixture file (single object)", () => {
  const dir = tmpDir();
  try {
    const p = join(dir, "fx.json");
    writeFileSync(p, JSON.stringify(VALID_FIXTURE));
    const { fixtures, source } = loadFixtures(parseEvaluateArgs(["--fixture", p], "b"));
    assert.equal(fixtures.length, 1);
    assert.equal(source, p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFixtures: scans .ikbi/fixtures/*.json when no --fixture", () => {
  const dir = tmpDir();
  try {
    const fxDir = join(dir, ".ikbi", "fixtures");
    mkdirSync(fxDir, { recursive: true });
    writeFileSync(join(fxDir, "a.json"), JSON.stringify(VALID_FIXTURE));
    writeFileSync(join(fxDir, "b.json"), JSON.stringify([VALID_FIXTURE, { ...VALID_FIXTURE, name: "two" }]));
    const { fixtures } = loadFixtures(parseEvaluateArgs(["--repo", dir], "b"));
    assert.equal(fixtures.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFixtures: falls back to built-in defaults", () => {
  const dir = tmpDir();
  try {
    const { fixtures, source } = loadFixtures(parseEvaluateArgs(["--repo", dir], "b"));
    assert.ok(fixtures.length >= 3);
    assert.match(source, /built-in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Output formatting ───────────────────────────────────────────────────────────

test("formatMarkdown renders a comparison table + routing", () => {
  const md = formatMarkdown([card("m1"), card("m2", { recommended_role: "patch_builder", routing_reason: "clean diffs" })], 3, "built-in defaults", ["agent", "patch", "plan_patch", "repair"]);
  assert.match(md, /# ikbi evaluate/);
  assert.match(md, /\| m1 \|/);
  assert.match(md, /\*\*agent_builder\*\*/);
  assert.match(md, /\*\*m2\*\* → patch_builder: clean diffs/);
});

// ── End-to-end run (injected harness) ────────────────────────────────────────────

test("run: markdown by default across two models", async () => {
  const dir = tmpDir();
  try {
    const cap = capture();
    const cli = createEvaluateCli({
      ...cap,
      defaultModel: "b",
      runHarness: async (model) => card(model),
    });
    await cli.run(["--models", "m1,m2", "--repo", dir]);
    assert.match(cap.out, /\| m1 \|/);
    assert.match(cap.out, /\| m2 \|/);
    assert.equal(cap.exit, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: --json emits scorecards", async () => {
  const dir = tmpDir();
  try {
    const cap = capture();
    const cli = createEvaluateCli({ ...cap, defaultModel: "b", runHarness: async (model) => card(model) });
    await cli.run(["--models", "m1", "--repo", dir, "--json"]);
    const parsed = JSON.parse(cap.out);
    assert.equal(parsed.scorecards.length, 1);
    assert.equal(parsed.scorecards[0].model, "m1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: --modes filters the observations shown (routing still full)", async () => {
  const dir = tmpDir();
  try {
    const cap = capture();
    const cli = createEvaluateCli({ ...cap, defaultModel: "b", runHarness: async (model) => card(model) });
    await cli.run(["--models", "m1", "--repo", dir, "--modes", "agent", "--json"]);
    const parsed = JSON.parse(cap.out);
    const obs = parsed.scorecards[0].observations;
    assert.ok(obs.length > 0);
    assert.ok(obs.every((o: { mode: string }) => o.mode === "agent"));
    // Routing recommendation is unchanged by the display filter.
    assert.equal(parsed.scorecards[0].recommended_role, "agent_builder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: --help prints usage and runs no harness", async () => {
  let ran = false;
  const cap = capture();
  const cli = createEvaluateCli({ ...cap, defaultModel: "b", runHarness: async (m) => { ran = true; return card(m); } });
  await cli.run(["--help"]);
  assert.match(cap.out, /Usage: ikbi evaluate/);
  assert.equal(ran, false);
});

test("run: a harness failure exits 1", async () => {
  const dir = tmpDir();
  try {
    const cap = capture();
    const cli = createEvaluateCli({ ...cap, defaultModel: "b", runHarness: async () => { throw new Error("model down"); } });
    await cli.run(["--models", "m1", "--repo", dir]);
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /harness failed.*model down/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: --write-providers invokes the routing writer", async () => {
  const dir = tmpDir();
  try {
    const cap = capture();
    let wrote: readonly CapabilityScorecard[] | undefined;
    const cli = createEvaluateCli({
      ...cap,
      defaultModel: "b",
      runHarness: async (model) => card(model),
      writeRouting: (cards) => { wrote = cards; return "/fake/providers.json"; },
    });
    await cli.run(["--models", "m1", "--repo", dir, "--write-providers"]);
    assert.ok(wrote !== undefined);
    assert.equal(wrote!.length, 1);
    assert.match(cap.out, /Routing written to \/fake\/providers.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Routing persistence ──────────────────────────────────────────────────────────

test("writeRoutingToProviders merges non-destructively + writes atomically", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "providers.json");
    writeFileSync(path, JSON.stringify({ providers: [{ id: "deepseek" }], routing: { old: "critic_only" } }));
    writeRoutingToProviders(path, [card("m1"), card("m2", { recommended_role: "patch_builder" })]);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    // Existing keys preserved.
    assert.deepEqual(parsed.providers, [{ id: "deepseek" }]);
    // Routing merged, not clobbered.
    assert.equal(parsed.routing.old, "critic_only");
    assert.equal(parsed.routing.m1, "agent_builder");
    assert.equal(parsed.routing.m2, "patch_builder");
    // No temp file left behind.
    assert.ok(!existsSync(`${path}.tmp.${process.pid}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRoutingToProviders creates the file when absent", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "nested", "providers.json");
    writeRoutingToProviders(path, [card("solo")]);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.routing.solo, "agent_builder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
