/**
 * PRODUCTION REACHABILITY (end-to-end half) — REQUIRES `pnpm build`.
 *
 * Real argv -> the real built binary -> `src/cli/index.ts`'s dispatcher -> the
 * registered v2 command -> the canonical v2 lifecycle. Nothing is stubbed and
 * nothing is imported: if the CLI ever stopped routing through the v2 spine (a
 * shortcut, a stale registration, a mock left behind), the journal and receipt this
 * suite parses would not exist and it would fail.
 *
 * It also pins the safety properties an operator is entitled to assume about an
 * experimental command: it changes nothing in the repository it is pointed at.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { loopbackEgressEnv, startFakeOpenAIProvider } from "./fake-provider-server.js";
import { initGitRepo } from "./fixture-repo.js";
import { sessionFinalAttempt } from "./session-json.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));
const IKBI_REPO = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * A small COMMITTED fixture repository. V2-006 allocates a worktree from HEAD and
 * re-observes a context artifact there, so pointing these suites at the ikbi checkout
 * would make them fail whenever the operator has an uncommitted CLAUDE.md — a real
 * behavior, but not what these suites are about.
 */
const REPO = initGitRepo({ "AGENTS.md": "# fixture conventions\nBe terse.\n", "src/widget.ts": "export const widget = 1;\n" });

/**
 * An isolated state root carrying a minimal, keyless roster. Isolation matters twice
 * over: the operator's real ~/.ikbi is never touched, and the run's configuration is
 * fixed here rather than inherited from whatever this machine happens to be set up for.
 */
const PROVIDER = await startFakeOpenAIProvider();
after(() => PROVIDER.close());

const roots: string[] = [];
function makeStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-smoke-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "providers.json"),
    JSON.stringify({
      providers: [{ id: "alpha", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, keyless: true }],
      models: [
        {
          id: "alpha-1",
          role: "builder",
          cost: { promptPerMTok: 0, completionPerMTok: 0 },
          providers: [{ provider: "alpha", providerModelId: "a1" }],
          // A declared window, so the context budget can be derived truthfully.
          capabilities: { context_window: 100000, supports_tools: true },
        },
      ],
    }),
  );
  return root;
}
const STATE_ROOT = makeStateRoot();

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function runCli(args: readonly string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "ikbi-v2-home-"));
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-cwd-")),
    // The tier vars pin the operator-configuration precedence layer at the fixture
    // model, so this suite tests the SPINE rather than this machine's model setup.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      IKBI_STATE_ROOT: STATE_ROOT,
      IKBI_MODEL_DRIVER: "alpha-1",
      IKBI_MODEL_BUILDER: "alpha-1",
      IKBI_MODEL_CRITIC: "alpha-1",
      ...extraEnv,
      ...loopbackEgressEnv(PROVIDER),
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("v2 cli: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

test("v2 cli: `ikbi v2 build` reaches the canonical v2 lifecycle end-to-end", () => {
  const r = runCli(["v2", "build", "a real goal", "--repo", REPO, "--json"]);
  // No manifest / no IKBI_CHECKS ⇒ NO_CHECKS ⇒ the candidate is WITHHELD (a correct,
  // intended result), so the exit code is 0. Nothing was promoted.
  assert.equal(r.status, 0, `expected a zero exit for a withheld candidate\n${r.stderr}`);
  const result = sessionFinalAttempt(r.stdout);
  assert.ok(result.taskId.startsWith("task_"));
  assert.ok(result.runId.startsWith("run_"));
  // Only the lifecycle machine writes this journal.
  assert.equal(result.journal[0]?.from, "pending");
  assert.equal(result.journal[0]?.to, "preflight");
  assert.equal(result.journal.at(-1)?.to, "terminal");
  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition"]);
  assert.equal(result.receipt.stagesEntered.includes("promotion"), false, "stops before the one unimplemented stage");
});

test("v2 cli: the end-to-end run claims NOTHING it did not do", () => {
  const r = runCli(["v2", "build", "promote everything", "--repo", REPO, "--json"]);
  const result = sessionFinalAttempt(r.stdout);
  assert.equal(result.outcome.kind, "withheld");
  assert.deepEqual(result.receipt.evidence, {
    // Configuration (V2-002) and route authorization (V2-003) happen — and nothing else.
    configurationResolved: true,
    sourceSnapshotCaptured: true,
    sourceSnapshots: 1,
    // A route WAS authorized and context WAS assembled. Neither is an invocation, and
    // the counters sitting side by side is how the receipt keeps that distinction honest.
    modelResolutionCompleted: true,
    modelResolutions: 2,
    contextAssemblyCompleted: true,
    contextPackages: 1,
    // V2-006B: deterministic retrieval ran while context was assembled. Ranking is not
    // an invocation either — note `invocations` below is still exactly one.
    retrievalPerformed: true,
    // V2-005: a real HTTP call to a protocol-faithful local provider really happened.
    providerInvoked: true,
    invocations: 2,
    // V2-015: the fake model ran no read-only commands.
    commandsRun: 0,
    // V2-006: one isolated workspace was allocated — and nothing was written in it.
    workspacesAllocated: 1,
    observationsTaken: 1,
    mutationsApplied: 0,
    // V2-007: the fake model finishes immediately having done nothing, which is a
    // legitimate no-change candidate. It has still been verified by nothing.
    candidatesCreated: 1,
    candidateMutated: false,
    verificationsPerformed: 1,
    promotionsAttempted: 0,
    promoted: false,
    sourceRepositoryMutated: false,
  });
});

test("v2 cli: it is safe to point at THIS repository — nothing is written", () => {
  // Deliberately the real ikbi checkout: whatever the run decides to do, the source
  // repository must be byte-identical afterwards. This holds even if the run stops early
  // (e.g. a locally-modified instruction file is correctly reported as context drift).
  const before = spawnSync("git", ["status", "--porcelain"], { cwd: IKBI_REPO, encoding: "utf8" }).stdout;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: IKBI_REPO, encoding: "utf8" }).stdout;
  // A trivial, allowlisted verification check so the run does NOT discover and execute
  // ikbi's OWN full test suite in the candidate worktree — which would be a recursive
  // build. The source-safety property is independent of which checks run.
  runCli(["v2", "build", "rewrite the world", "--repo", IKBI_REPO], { IKBI_CHECKS: '[{"name":"noop","command":"echo","args":["ok"]}]' });
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: IKBI_REPO, encoding: "utf8" }).stdout, before, "working tree unchanged");
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: IKBI_REPO, encoding: "utf8" }).stdout, head, "HEAD unchanged");
});

test("v2 cli: shadow and tournament strategies are accepted by the spine", () => {
  for (const strategy of ["shadow", "tournament"]) {
    const r = runCli(["v2", "build", "race it", "--repo", REPO, "--strategy", strategy, "--json"]);
    const result = sessionFinalAttempt(r.stdout);
    assert.ok(result.outcome.kind === "withheld", `${strategy} passed preflight and adjudicated`);
    assert.equal(result.receipt.stagesEntered.includes("disposition"), true, `${strategy} reached disposition`);
  }
});

test("v2 cli: `ikbi v2 --help` prints help and does NOT execute a run", () => {
  const r = runCli(["v2", "--help"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.includes('"journal"'), false, "help never enters the lifecycle");
});

test("v2 cli: v1 `build`, the `legacy` namespace, and the `v2` alias are all registered", () => {
  const r = runCli(["help", "--advanced"]);
  assert.equal(r.status, 0, r.stderr);
  for (const cmd of ["build", "fix", "repl", "doctor", "legacy"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `\`ikbi ${cmd}\` is listed`);
  }
  assert.match(r.stdout, /\bv2\b/, "and the v2 alias appears in the advanced list");
});

test("v2 cli: the default help does NOT advertise the advanced alias", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /^\s*v2\b/m, "v2 stays out of the golden-path help");
});

// ── V2-018 CUTOVER: the NORMAL command is the governed v2 engine ─────────────

test("cutover: `ikbi build` (the NORMAL command) reaches the canonical v2 lifecycle end-to-end", () => {
  const r = runCli(["build", "a real goal", "--repo", REPO, "--json"]);
  assert.equal(r.status, 0, `expected a zero exit for a withheld candidate\n${r.stderr}`);
  const result = sessionFinalAttempt(r.stdout);
  assert.ok(result.taskId.startsWith("task_"), "the normal command minted a v2 task");
  assert.ok(result.runId.startsWith("run_"));
  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition"]);
  // The governed (non-experimental) banner — not the experimental one.
  assert.match(r.stderr, /governed v2 build engine/, "the normal command announces the governed engine");
  assert.doesNotMatch(r.stderr, /EXPERIMENTAL/, "the normal command is not labelled experimental");
});

test("cutover: `ikbi build` and `ikbi v2 build` reach the SAME v2 handler (no behavior fork)", () => {
  const build = sessionFinalAttempt(runCli(["build", "identical goal", "--repo", REPO, "--json"]).stdout);
  const v2 = sessionFinalAttempt(runCli(["v2", "build", "identical goal", "--repo", REPO, "--json"]).stdout);
  // Different session/run identities (each is its own run) but IDENTICAL spine + evidence shape.
  assert.deepEqual(build.receipt.stagesEntered, v2.receipt.stagesEntered, "same stages");
  assert.deepEqual(build.receipt.evidence, v2.receipt.evidence, "same counted evidence");
  assert.equal(build.outcome.kind, v2.outcome.kind, "same outcome kind");
});

test("cutover: shadow + tournament run through the NORMAL `ikbi build` command", () => {
  for (const strategy of ["shadow", "tournament"]) {
    const r = runCli(["build", "race it", "--repo", REPO, "--strategy", strategy, "--json"]);
    const result = sessionFinalAttempt(r.stdout);
    assert.ok(result.outcome.kind === "withheld", `${strategy} passed preflight and adjudicated`);
    assert.equal(result.receipt.stagesEntered.includes("disposition"), true, `${strategy} reached disposition`);
  }
});

test("cutover: `ikbi build` defaults to the SINGLE strategy (predictable cost)", () => {
  const result = sessionFinalAttempt(runCli(["build", "just do it", "--repo", REPO, "--json"]).stdout);
  assert.equal(result.receipt.strategy?.kind, "single", "the daily-driver default is one candidate");
  assert.equal(result.receipt.strategy?.candidateCount, 1);
});

test("cutover: `ikbi build --json` emits the COMPLETE governed session receipt (build-command truth)", () => {
  const session = JSON.parse(runCli(["build", "tell the truth", "--repo", REPO, "--json"]).stdout) as {
    buildSessionId: string;
    outcome: { kind: string };
    receipt: { totalAttempts: number; cost: { totalInvocations: number; formattedKnownCostUsd: string } };
    attempts: unknown[];
  };
  assert.ok(session.buildSessionId.startsWith("bsn_") || session.buildSessionId.length > 0, "a BuildSessionId is reported");
  assert.equal(typeof session.receipt.totalAttempts, "number", "attempts are counted");
  assert.equal(typeof session.receipt.cost.totalInvocations, "number", "cost/model-call accounting is present");
  assert.ok(typeof session.receipt.cost.formattedKnownCostUsd === "string", "a known-cost figure is present");
  assert.ok(session.attempts.length >= 1, "the attempt ledger is present");
  assert.ok(["accepted", "withheld", "rejected", "quarantined", "failed"].includes(session.outcome.kind), "a lawful terminal outcome");
});

test("cutover: `ikbi build --strategy tournament --json` shows all candidates + the ONE selection", () => {
  const result = sessionFinalAttempt(runCli(["build", "race hard", "--repo", REPO, "--strategy", "tournament", "--json"]).stdout);
  assert.equal(result.receipt.strategy?.kind, "tournament");
  assert.equal(result.receipt.candidates?.length, 3, "three candidates are each accounted for on the receipt");
  assert.ok(result.receipt.selection !== undefined, "the ONE selection is recorded");
});

test("cutover: `ikbi legacy` is visibly legacy and cannot be entered by accident", () => {
  // Bare `ikbi legacy` refuses with a pointer to the daily driver — it never runs anything.
  const bare = runCli(["legacy"]);
  assert.equal(bare.status, 2, "bare legacy refuses");
  assert.match(bare.stderr, /legacy build/, "names the only legacy subcommand");
  assert.match(bare.stderr, /ikbi build/, "points at the governed daily driver");
  assert.equal(bare.stdout.includes('"journal"'), false, "legacy never enters the v2 lifecycle");
  // And nothing about the golden-path help suggests legacy is the normal build.
  const help = runCli(["help"]);
  assert.doesNotMatch(help.stdout, /^\s*legacy\b/m, "legacy stays out of the golden-path help");
});
