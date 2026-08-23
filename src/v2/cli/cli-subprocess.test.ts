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

import { HERMETIC_DEV_KEY_ENV } from "../test-env.js";
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
function makeStateRoot(server: { baseUrl: string } = PROVIDER): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-smoke-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "providers.json"),
    JSON.stringify({
      providers: [{ id: "alpha", kind: "openai-compatible", baseUrl: server.baseUrl, keyless: true }],
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

function runCli(args: readonly string[], extraEnv: Record<string, string> = {}, stateRoot: string = STATE_ROOT): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "ikbi-v2-home-"));
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-cwd-")),
    // The tier vars pin the operator-configuration precedence layer at the fixture
    // model, so this suite tests the SPINE rather than this machine's model setup.
    env: {
      PATH: process.env.PATH ?? "",
      // CONTAINMENT. A spawned child that inherits no TMPDIR falls back to /tmp, and every
      // fixture it makes there escapes the run root the wrapper cleans up. Forwarded explicitly
      // because this env is an allowlist — the child gets nothing that is not named here.
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HOME: home,
      IKBI_STATE_ROOT: stateRoot,
      IKBI_MODEL_DRIVER: "alpha-1",
      IKBI_MODEL_BUILDER: "alpha-1",
      IKBI_MODEL_CRITIC: "alpha-1",
      // MEDIUM-01: the child env is deliberately sanitized (no inherited developer shell), so the
      // synthetic-credential opt-in must be injected EXPLICITLY rather than leaked in from the
      // outer test runner. One owner for both the in-process and child paths.
      ...HERMETIC_DEV_KEY_ENV,
      // The shared provider's loopback allowance comes FIRST so `extraEnv` can override it: a
      // test that stands up its OWN fake provider on its own port must be able to point the
      // egress floor at that port. With this last, its allowance was silently replaced and the
      // run failed to reach its provider at all — which looks like a model that did nothing.
      ...loopbackEgressEnv(PROVIDER),
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("v2 cli: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

test("v2 cli: `ikbi v2 build` reaches the canonical v2 lifecycle end-to-end", () => {
  const r = runCli(["v2", "build", "--allow-repo-wide", "a real goal", "--repo", REPO, "--json"]);
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
  const r = runCli(["v2", "build", "--allow-repo-wide", "promote everything", "--repo", REPO, "--json"]);
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

/*
  ────────────────────────────────────────────────────────────────────────────
  SOURCE SAFETY, WITHOUT MUTATING THE CANONICAL CHECKOUT (DD-03).

  THE DEFECT THIS REPLACES. The previous version of this property ran the CLI with
  `--repo <the real ikbi checkout>`. Its assertions were true and stayed true — the working
  tree and HEAD really were untouched — but they were not the whole of what a build writes.
  Allocating a candidate workspace registers a worktree in the TARGET repository's git
  administration and creates an `ikbi/ws/<id>` ref there, and the worktree lived under this
  suite's disposable state root. `after()` deleted that root, the directory vanished, and the
  registration plus the ref stayed in the canonical `.git` forever, discoverable by nothing.

  One run of this file leaked exactly one registration and one ref. Repeated over the life of
  the suite that reached 168 registrations — 147 of them pointing at directories that no longer
  exist — and 169 scratch refs, at which point `git branch` in the canonical checkout was no
  longer readable by a human.

  WHAT REPLACES IT. The property is kept and STRENGTHENED. The build is pointed at a
  DISPOSABLE fixture, where mutation is observable and harmless, and the canonical checkout is
  now asserted over the exact thing the old test could not see: the full identity of every
  worktree registration and every scratch ref, compared tuple-for-tuple before and after the
  subprocess. A future change that points a run back at the canonical repository fails here
  instead of silently accumulating.

  The comparison is deliberately made BEFORE any fixture teardown, and teardown removes only
  the fixture. Cleanup that also swept canonical leaks would hide the very regression this
  exists to catch.
  ────────────────────────────────────────────────────────────────────────────
*/

/** One worktree registration, as git reports it: path, HEAD, branch, locked and prunable state. */
interface CanonicalRegistration {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
  readonly locked: string;
  readonly prunable: string;
}

/** The exact identity of the canonical checkout's workspace bookkeeping. Read-only. */
interface CanonicalIdentity {
  readonly registrations: readonly CanonicalRegistration[];
  readonly scratchRefs: readonly string[];
}

/**
 * Read the canonical checkout's registration + scratch-ref identity.
 *
 * SETS, NOT COUNTS. A count can stay equal while a leak replaces one entry with another, and
 * the failure this guards is exactly a new entry appearing. Every field git reports is carried
 * so a changed HEAD, a new lock or a newly-prunable entry is a difference too.
 */
function canonicalIdentity(): CanonicalIdentity {
  const porcelain = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: IKBI_REPO, encoding: "utf8" }).stdout;
  const registrations: CanonicalRegistration[] = [];
  let cur: { path: string; head: string; branch: string; locked: string; prunable: string } | undefined;
  const flush = (): void => { if (cur !== undefined) registrations.push(cur); cur = undefined; };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) { flush(); cur = { path: line.slice(9).trim(), head: "", branch: "", locked: "", prunable: "" }; }
    else if (cur === undefined) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim();
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = line.length > 6 ? line.slice(7).trim() : "locked";
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = line.length > 8 ? line.slice(9).trim() : "prunable";
    else if (line.trim() === "") flush();
  }
  flush();
  const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)|%(objectname)", "refs/heads/ikbi/ws/"], { cwd: IKBI_REPO, encoding: "utf8" }).stdout;
  return {
    registrations: registrations.sort((a, b) => a.path.localeCompare(b.path)),
    scratchRefs: refs.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).sort(),
  };
}

/** Assert the canonical checkout's bookkeeping is tuple-for-tuple what it was. */
function assertCanonicalUntouched(before: CanonicalIdentity, what: string): void {
  const after = canonicalIdentity();
  const newRefs = after.scratchRefs.filter((r) => !before.scratchRefs.includes(r));
  const beforePaths = new Set(before.registrations.map((r) => r.path));
  const newRegs = after.registrations.filter((r) => !beforePaths.has(r.path));
  assert.deepEqual(newRegs, [], `${what} LEAKED ${newRegs.length} worktree registration(s) into the canonical checkout`);
  assert.deepEqual(newRefs, [], `${what} LEAKED ${newRefs.length} scratch ref(s) into the canonical checkout`);
  // Full tuple equality last, so the two messages above name the common failure precisely
  // and this one catches anything else that moved (a changed HEAD, a new lock, a removal).
  assert.deepEqual(after, before, `${what} changed the canonical checkout's worktree bookkeeping`);
}

test("v2 cli: a build mutates NOTHING in the repository it is pointed at, and nothing in the canonical checkout", () => {
  // A DISPOSABLE fixture, so a mutation would be observable here rather than in the operator's
  // own checkout. Its own git state carries the source-safety property the old test asserted.
  const target = initGitRepo({ "AGENTS.md": "# fixture conventions\nBe terse.\n", "src/widget.ts": "export const widget = 1;\n" });
  const targetStatus = spawnSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" }).stdout;
  const targetHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).stdout;

  const before = canonicalIdentity();
  // A trivial, allowlisted verification check so the run does NOT discover and execute a full
  // test suite in the candidate worktree. The source-safety property is independent of which
  // checks run.
  runCli(["v2", "build", "--allow-repo-wide", "rewrite the world", "--repo", target], { IKBI_CHECKS: '[{"name":"noop","command":"echo","args":["ok"]}]' });
  assertCanonicalUntouched(before, "a build pointed at a disposable fixture");

  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" }).stdout, targetStatus, "the target working tree is unchanged");
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).stdout, targetHead, "the target HEAD is unchanged");
});

test("v2 cli: a SUCCESSFUL build that really PUBLISHES leaks nothing into the canonical checkout", async () => {
  // A build that reaches publication is the case with the most to leak: it allocates a
  // workspace, writes in it, verifies, and moves the target ref. All of that must happen in
  // the fixture and none of it anywhere else.
  const scripted = await startFakeOpenAIProvider({
    script: [
      { toolCalls: [{ name: "read_file", args: { path: "src/widget.ts" } }] },
      { toolCalls: [{ name: "replace_file", args: { path: "src/widget.ts", content: "export const widget = 2;\n" }, observationFrom: "src/widget.ts" }] },
      { toolCalls: [{ name: "finish_candidate", args: { summary: "set widget to 2", believesComplete: true } }] },
    ],
    criticResponse: JSON.stringify({ verdict: "satisfied", summary: "widget = 2 as requested.", defects: [] }),
  });
  try {
    const root = makeStateRoot(scripted);
    const target = initGitRepo({ "src/widget.ts": "export const widget = 1;\n" });
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).stdout.trim();

    const before = canonicalIdentity();
    const r = runCli(
      ["build", "--allow-repo-wide", "set widget to 2 in src/widget.ts", "--repo", target, "--json"],
      { IKBI_CHECKS: '[{"name":"widget","command":"grep","args":["-q","widget = 2","src/widget.ts"]}]', ...loopbackEgressEnv(scripted) },
      root,
    );
    assertCanonicalUntouched(before, "a successful publishing build");

    /*
      THE COVERAGE THIS PROTECTS. A run that reaches PUBLICATION is the case with the most to
      leak: it allocates a candidate workspace, writes in it, verifies it, and moves the target
      ref. All of that registers worktrees and scratch refs in the TARGET repository — which is
      precisely the leak surface — so asserting "nothing leaked" is only meaningful if the run
      really got that far. The receipt is what makes the assertion non-vacuous.
    */
    const ev = sessionFinalAttempt(r.stdout).receipt.evidence;
    assert.equal(ev.workspacesAllocated, 1, `a workspace must really have been allocated\n${r.stderr}`);
    assert.ok(ev.mutationsApplied >= 1, "the scripted builder really wrote in it");
    assert.equal(ev.candidateMutated, true, "the candidate differs from the source");
    assert.ok(ev.verificationsPerformed >= 1, "verification really ran");
    assert.equal(ev.promoted, true, `the candidate was published\n${r.stderr}`);
    assert.equal(ev.sourceRepositoryMutated, true, "and the target ref really moved");

    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).stdout.trim();
    assert.notEqual(headAfter, headBefore, "the FIXTURE's ref advanced — publication landed there");
    assert.match(spawnSync("git", ["show", "HEAD:src/widget.ts"], { cwd: target, encoding: "utf8" }).stdout, /widget = 2/, "the published tree is the candidate's");
  } finally {
    await scripted.close();
  }
});

test("v2 cli: a build that FAILS after the workspace exists leaks nothing into the canonical checkout", async () => {
  // The failure path is where cleanup is easiest to skip: the workspace is allocated before the
  // first model call, so a provider that refuses every request fails with the worktree already
  // registered. Whatever the run retains, it must be retained in the fixture's bookkeeping.
  const broken = await startFakeOpenAIProvider({ status: 503 });
  try {
    const root = makeStateRoot(broken);
    const target = initGitRepo({ "src/widget.ts": "export const widget = 1;\n" });

    const before = canonicalIdentity();
    const r = runCli(
      ["build", "--allow-repo-wide", "this build cannot succeed", "--repo", target, "--json"],
      { IKBI_CHECKS: '[{"name":"noop","command":"echo","args":["ok"]}]', ...loopbackEgressEnv(broken) },
      root,
    );
    assertCanonicalUntouched(before, "a build that failed after workspace creation");
    assert.notEqual(r.status, 0, "a provider that refuses everything must not report success");
  } finally {
    await broken.close();
  }
});

test("v2 cli: shadow and tournament strategies are accepted by the spine", () => {
  for (const strategy of ["shadow", "tournament"]) {
    const r = runCli(["v2", "build", "--allow-repo-wide", "race it", "--repo", REPO, "--strategy", strategy, "--json"]);
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

test("v2 cli: the normal commands and the `v2` alias are registered; `legacy` is only a tombstone", () => {
  const r = runCli(["help", "--advanced"]);
  assert.equal(r.status, 0, r.stderr);
  for (const cmd of ["build", "fix", "repl", "doctor"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `\`ikbi ${cmd}\` is listed`);
  }
  assert.match(r.stdout, /\bv2\b/, "and the v2 alias appears in the advanced list");
  // V2-020: `legacy` still appears in the ADVANCED list, but only as a retirement notice — the
  // name is claimed so the old invocation refuses instead of being read as a REPL chat prompt.
  assert.match(r.stdout, /legacy.*RETIRED/i, "the advanced list shows legacy as retired, not as an engine");
});

test("v2 cli: the default help does NOT advertise the advanced alias", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /^\s*v2\b/m, "v2 stays out of the golden-path help");
});

// ── V2-018 CUTOVER: the NORMAL command is the governed v2 engine ─────────────

test("cutover: `ikbi build` (the NORMAL command) reaches the canonical v2 lifecycle end-to-end", () => {
  const r = runCli(["build", "--allow-repo-wide", "a real goal", "--repo", REPO, "--json"]);
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
  const build = sessionFinalAttempt(runCli(["build", "--allow-repo-wide", "identical goal", "--repo", REPO, "--json"]).stdout);
  const v2 = sessionFinalAttempt(runCli(["v2", "build", "--allow-repo-wide", "identical goal", "--repo", REPO, "--json"]).stdout);
  // Different session/run identities (each is its own run) but IDENTICAL spine + evidence shape.
  assert.deepEqual(build.receipt.stagesEntered, v2.receipt.stagesEntered, "same stages");
  assert.deepEqual(build.receipt.evidence, v2.receipt.evidence, "same counted evidence");
  assert.equal(build.outcome.kind, v2.outcome.kind, "same outcome kind");
});

test("cutover: shadow + tournament run through the NORMAL `ikbi build` command", () => {
  for (const strategy of ["shadow", "tournament"]) {
    const r = runCli(["build", "--allow-repo-wide", "race it", "--repo", REPO, "--strategy", strategy, "--json"]);
    const result = sessionFinalAttempt(r.stdout);
    assert.ok(result.outcome.kind === "withheld", `${strategy} passed preflight and adjudicated`);
    assert.equal(result.receipt.stagesEntered.includes("disposition"), true, `${strategy} reached disposition`);
  }
});

test("cutover: `ikbi build` defaults to the SINGLE strategy (predictable cost)", () => {
  const result = sessionFinalAttempt(runCli(["build", "--allow-repo-wide", "just do it", "--repo", REPO, "--json"]).stdout);
  assert.equal(result.receipt.strategy?.kind, "single", "the daily-driver default is one candidate");
  assert.equal(result.receipt.strategy?.candidateCount, 1);
});

test("cutover: `ikbi build --json` emits the COMPLETE governed session receipt (build-command truth)", () => {
  const session = JSON.parse(runCli(["build", "--allow-repo-wide", "tell the truth", "--repo", REPO, "--json"]).stdout) as {
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
  const result = sessionFinalAttempt(runCli(["build", "--allow-repo-wide", "race hard", "--repo", REPO, "--strategy", "tournament", "--json"]).stdout);
  assert.equal(result.receipt.strategy?.kind, "tournament");
  assert.equal(result.receipt.candidates?.length, 3, "three candidates are each accounted for on the receipt");
  assert.ok(result.receipt.selection !== undefined, "the ONE selection is recorded");
});

test("cutover: `ikbi legacy` is RETIRED — it is not a command and runs nothing", () => {
  // V2-018 kept the v1 engine reachable as `ikbi legacy build` for the qualification window.
  // V2-020 removed it. An unknown command must be refused, and it must not quietly do anything.
  const bare = runCli(["legacy"]);
  assert.equal(bare.status, 2, "`ikbi legacy` refuses");
  assert.match(bare.stderr, /RETIRED/, "and says plainly that it is retired");
  assert.match(bare.stderr, /ikbi build/, "pointing at the canonical engine");
  assert.equal(bare.stdout.includes('"journal"'), false, "nothing entered any build lifecycle");

  // The muscle-memory invocation must refuse too — never reinterpreted as a chat prompt, never run.
  const build = runCli(["legacy", "build", "--allow-repo-wide", "do a thing"]);
  assert.equal(build.status, 2, "`ikbi legacy build` cannot start the retired v1 engine");
  assert.match(build.stderr, /Nothing was run/, "it states that nothing happened");
  assert.equal(build.stdout.includes('"journal"'), false, "and it started no run of any kind");
});
