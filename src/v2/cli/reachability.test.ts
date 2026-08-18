/**
 * PRODUCTION REACHABILITY (in-process half).
 *
 * A feature is not done because a class exists and has unit tests — that is the
 * exact failure v2 is being built to stop repeating. So this suite asserts the
 * command is really wired into the CLI's dispatch registry (the same registry
 * `src/cli/index.ts` consults for every subcommand), and that driving the command
 * body produces output that could only have come from the canonical v2 lifecycle.
 *
 * The end-to-end half — real argv through the real built binary — is
 * `cli-subprocess.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { commands } from "../../cli/registry.js";
import type { ConfigurationSource } from "../core/config.js";
import { LIFECYCLE_STAGES } from "../core/lifecycle.js";
import type { V2RunResult } from "../core/result.js";
import { FIRST_UNIMPLEMENTED_STAGE } from "../core/run.js";
import { V2_BANNER, parseV2Args, renderRun, runV2Cli } from "./index.js";

/**
 * A hermetic configuration source. These tests are about CLI dispatch reaching the
 * spine; they must not read (or depend on) the operator's real ~/.ikbi state. The
 * subprocess suite covers the real production wiring.
 */
const hermeticConfiguration: ConfigurationSource = {
  load: async () => ({
    inventory: { providers: [], models: [] },
    activeProfile: { kind: "none" },
    operatorDefaults: { models: [] },
  }),
};

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    cwd: process.cwd(),
    configuration: hermeticConfiguration,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

test("reachability: `ikbi v2` is REGISTERED in the CLI dispatch registry", () => {
  const cmd = commands.get("v2");
  assert.ok(cmd !== undefined, "importing the v2 CLI registers the command");
  assert.equal(cmd!.category, "advanced", "v2 is experimental — it stays out of the default help");
  assert.match(cmd!.summary, /EXPERIMENTAL/);
  assert.match(cmd!.usage ?? "", /v2 build/);
});

test("reachability: v2 registers into the SAME registry v1 dispatches from", () => {
  // The shared, process-wide registrar rejects duplicates — so a successful second
  // registration attempt would mean this suite is talking to some other registry.
  assert.throws(
    () => commands.register({ name: "v2", summary: "duplicate", run: () => undefined }),
    /already registered/,
  );
  assert.ok(commands.all().some((c) => c.name === "v2"), "`ikbi help --advanced` will list it");
});

test("reachability: the command body enters the canonical lifecycle and reports it", async () => {
  const cap = capture();
  const code = await runV2Cli(["build", "add", "a", "thing"], cap);
  assert.equal(cap.err, V2_BANNER, "the experimental banner goes to stderr, not stdout");
  assert.match(cap.out, /stages\s+preflight$/m, "the run entered exactly the preflight stage");
  assert.match(cap.out, /not implemented/, "and said so truthfully");
  assert.notEqual(code, 0, "an unimplemented lifecycle is not a success");
});

test("reachability: the JSON surface carries the lifecycle journal + a counted receipt", async () => {
  const cap = capture();
  await runV2Cli(["build", "x", "--json"], cap);
  const result = JSON.parse(cap.out) as V2RunResult;
  // Only the real lifecycle produces this: a journal that starts at `pending`, enters
  // preflight, and ends at `terminal`. A CLI that shortcut past the spine could not.
  assert.equal(result.journal[0]?.from, "pending");
  assert.equal(result.journal[0]?.to, "preflight");
  assert.equal(result.journal.at(-1)?.to, "terminal");
  assert.deepEqual(result.receipt.stagesEntered, ["preflight"]);
  assert.equal(result.outcome.kind, "failed");
  assert.deepEqual(result.receipt.evidence, {
    // Configuration IS resolved in preflight (V2-002) — and it is the only thing that is.
    configurationResolved: true,
    providerInvoked: false,
    invocations: 0,
    candidatesCreated: 0,
    verificationsPerformed: 0,
    promotionsAttempted: 0,
    promoted: false,
    repositoryMutated: false,
  });
});

test("reachability: the CLI never claims a stage it did not run", async () => {
  const cap = capture();
  await runV2Cli(["build", "x", "--json"], cap);
  const result = JSON.parse(cap.out) as V2RunResult;
  for (const stage of LIFECYCLE_STAGES) {
    if (stage === "preflight") continue;
    assert.equal(result.receipt.stagesEntered.includes(stage), false, `never entered ${stage}`);
  }
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.detail?.missingStage, FIRST_UNIMPLEMENTED_STAGE);
});

test("reachability: an unknown v2 subcommand is refused, not silently built", async () => {
  const cap = capture();
  const code = await runV2Cli(["promote", "everything"], cap);
  assert.equal(code, 2);
  assert.equal(cap.out, "", "nothing was printed as if a run had happened");
  assert.match(cap.err, /unknown subcommand/);
});

test("reachability: a bad repo path fails preflight through the CLI", async () => {
  const cap = capture();
  const code = await runV2Cli(["build", "x", "--repo", "/nonexistent/ikbi-v2-probe"], cap);
  assert.notEqual(code, 0);
  assert.match(cap.out, /\[preflight\] no such path/);
});

test("reachability: argv parsing keeps multi-word goals and flags apart", () => {
  const args = parseV2Args(["build", "make", "the", "thing", "--repo", "/r", "--strategy", "tournament", "--json"], "/cwd");
  assert.equal(args.subcommand, "build");
  assert.equal(args.goal, "make the thing");
  assert.equal(args.repo, "/r");
  assert.equal(args.strategy, "tournament");
  assert.equal(args.json, true);
  assert.equal(parseV2Args(["build", "solo"], "/cwd").repo, "/cwd", "the repo defaults to the cwd");
});

test("reachability: the human rendering states the evidence explicitly", async () => {
  const cap = capture();
  await runV2Cli(["build", "x"], cap);
  assert.match(cap.out, /provider_invoked=false/);
  assert.match(cap.out, /promoted=false/);
  assert.match(cap.out, /repo_mutated=false/);
  assert.ok(typeof renderRun === "function");
});
