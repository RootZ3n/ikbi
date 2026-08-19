import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { commands } from "../../cli/registry.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { autonomyForTier, asTier, type TrustDecision } from "../../core/trust/index.js";
import { TRUST_FLOOR } from "../../core/trust/index.js";
import type { DiscardResult, PromoteGovernance, PromoteResult, WorkspaceHandle } from "../../core/workspace/contract.js";
import { createGateWall } from "../gate-wall/index.js";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { WORKER_ROLES, WorkerError, CONTRACT_VERSION, type RoleContext, type RoleFn, type WorkerResult, type WorkerRole, type WorkerTask } from "./contract.js";
// Importing cli.js registers the `build` command at module load.
import { createWorkerCli, loadScopePlan, parseBuildArgs, productionRoleClaim } from "./cli.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as tmpJoin } from "node:path";

const silent = () => pino({ level: "silent" });
const OPERATOR_TOKEN = "operator-token-value";
const WORKER_TOKEN = "worker-token-value";

/** A resolver over operator + worker agents at chosen tiers (the real identity path). */
function makeResolver(operatorTier: string, workerTier: string) {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({
      agents: [
        { agentId: "lead", kind: "agent", functionalRole: "lead", defaultTrustTier: operatorTier, tokenHashes: [hashToken(OPERATOR_TOKEN)] },
        { agentId: "worker", kind: "agent", functionalRole: "worker", defaultTrustTier: workerTier, tokenHashes: [hashToken(WORKER_TOKEN)] },
      ],
    }),
    logger: silent(),
    now: () => 1000,
  });
  return (claim: { token?: string }) => resolver.resolve(claim);
}

/** Capturing role set: records each RoleContext; integrator returns a PROMOTE decision. */
function capturingRoles() {
  const seen: RoleContext[] = [];
  const roles: Partial<Record<WorkerRole, RoleFn>> = {};
  for (const r of WORKER_ROLES) {
    roles[r] = async (ctx) => {
      seen.push(ctx);
      if (r === "integrator") return { role: r, outcome: "success", summary: r, detail: { decision: "promote", rationale: "test", evaluation: { approved: true } } };
      if (r === "verifier") return { role: r, outcome: "success", summary: r, detail: { verdict: "pass", checks: [{ name: "test", command: "pnpm test", exitCode: 0, testCount: { passed: 1, total: 1 } }] } };
      // A GREEN critic carries an explicit PASS verdict — the field the authoritative adjudication core
      // reads (`criticDetail.pass === true`). Without it the core retains (critic-fail-exhausted).
      if (r === "critic") return { role: r, outcome: "success", summary: r, detail: { pass: true } };
      return { role: r, outcome: "success", summary: r };
    };
  }
  return { seen, roles };
}

function fakeWorkspaceHandle(): WorkspaceHandle {
  return { id: "wsabcd", targetRepo: "/repo", baseBranch: "main", baseRef: "deadbeef", scratchBranch: "ikbi/ws/wsabcd", path: "/tmp/wsabcd", identity: { agentId: "lead" }, state: "allocated", createdAt: 1000 };
}

/**
 * INJECTED TEST FACT (adjudication seam): a tree-bound GREEN work product for a promotable candidate.
 * These CLI tests wire in-memory workspace doubles with non-existent paths, so the authoritative
 * adjudication core (which requires a real tree-bound WorkProduct) is fed this labeled fact via the
 * explicit `deps.computeWorkProduct` seam. Production always computes from real git.
 */
function promotableWorkProduct(treeHash = "test-tree-green"): NonNullable<OrchestratorDeps["computeWorkProduct"]> {
  return async () => ({ treeHash, diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, nonEmpty: true });
}

/** Workspaces fake that HONORS governance at promote + captures the verdict. No real git. */
function governanceWorkspaces() {
  let captured: PromoteGovernance | undefined;
  const calls = { promote: 0, discard: 0 };
  const handle = fakeWorkspaceHandle();
  const workspaces: NonNullable<OrchestratorDeps["workspaces"]> = {
    allocate: async () => handle,
    promote: async (h, a): Promise<PromoteResult> => {
      calls.promote += 1;
      captured = a.governance;
      return a.governance?.allow
        ? { promoted: true, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", afterRef: "b" }
        : { promoted: false, workspaceId: h.id, targetBranch: h.baseBranch, beforeRef: "a", reason: "governance denied" };
    },
    discard: async (h): Promise<DiscardResult> => {
      calls.discard += 1;
      return { workspaceId: h.id, removed: true };
    },
  };
  return { workspaces, governance: () => captured, calls };
}

const fakeTrust = () => ({
  recordOutcome: async (i: { agentId: string; operation: string; status: string; defaultTrustTier: string }): Promise<TrustDecision> => {
    const tier = asTier(i.defaultTrustTier, TRUST_FLOOR);
    return { agentId: i.agentId, tier, previousTier: tier, autonomy: autonomyForTier(tier) };
  },
});
const fakeReceipts = () => ({ append: async (_i: unknown, _id: AgentIdentity): Promise<unknown> => ({}) });
const noopBus = () => ({
  publish: <P>(input: P) => ({ ...(input as object), contractVersion: "1.0.0", id: "e", seq: 1, timestamp: 0 }) as unknown,
  subscribe: () => ({ id: "s", unsubscribe: () => {}, stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) }),
  flush: async () => {},
});

const ENABLED = { enabled: true, roleTimeoutMs: 1000, maxConcurrentRuns: 1 };

/** Build a REAL orchestrator wired with the production roleClaim + REAL gate-wall + fakes. */
function realOrchestrator(operatorTier: string, workerTier: string) {
  const resolveIdentity = makeResolver(operatorTier, workerTier);
  const cap = capturingRoles();
  const ws = governanceWorkspaces();
  const realGateWall = createGateWall({ receipts: fakeReceipts(), publish: () => {} }); // REAL evaluator
  let gateDecision: PromoteGovernance | undefined;
  const gateWall = {
    evaluate: async (...args: Parameters<typeof realGateWall.evaluate>): Promise<PromoteGovernance> => {
      gateDecision = await realGateWall.evaluate(...args);
      return gateDecision;
    },
  };
  const orchestrator = createOrchestrator({
    config: ENABLED,
    resolveIdentity,
    roleClaim: productionRoleClaim(WORKER_TOKEN), // PRODUCTION shared-worker claim
    roles: cap.roles,
    workspaces: ws.workspaces,
    gateWall,
    trust: fakeTrust(),
    receipts: fakeReceipts(),
    events: noopBus() as unknown as NonNullable<OrchestratorDeps["events"]>,
    // Adjudication seam: these workspace doubles have no real git worktree — inject a tree-bound GREEN
    // work product so the authoritative core reaches its real chokepoints (promote for trusted, the
    // gate-wall's deny for probation) instead of failing closed on an absent WorkProduct fact.
    computeWorkProduct: promotableWorkProduct(),
    invokeModel: async () => {
      throw new Error("invokeModel not used (capturing roles)");
    },
  });
  return { orchestrator, resolveIdentity, cap, ws, gateDecision: () => gateDecision };
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

// ── registration ─────────────────────────────────────────────────────────────

test("the v1 worker pipeline registers NO build command at all (V2-020 retirement)", () => {
  // V2-018 froze v1 behind `ikbi legacy build` for the qualification window. V2-020 removed that
  // command: the audits are complete, and a second production build authority an operator can type
  // is the hidden v1 authority this repository converged away from. Importing THIS module must now
  // register no way to enter the v1 engine — `ikbi build` (v2) is the one build surface.
  //
  // The module is still imported for its NON-build exports (`createWorkerCli` for `ikbi run`, the
  // `diff`/`repos` commands, `productionRoleClaim`), so "registers nothing at all" is not the claim.
  // The NAME is still claimed, by a tombstone that refuses — otherwise `ikbi legacy build "…"`
  // falls through to the REPL and is read as a chat prompt, which is worse than a clean refusal.
  const legacy = commands.get("legacy");
  assert.ok(legacy !== undefined, "the retired name is claimed so it cannot be reinterpreted");
  assert.match(legacy!.summary ?? "", /RETIRED/, "and it says so");
  assert.equal(commands.has("build"), false, "worker-model does not register `build` — v2 owns it");
  for (const name of ["v1", "worker", "legacy-build"]) {
    assert.equal(commands.has(name), false, `no v1 build surface may reappear as \`${name}\``);
  }
});

test("productionRoleClaim returns the worker token for ALL roles; throws fail-closed when unset", () => {
  const claim = productionRoleClaim(WORKER_TOKEN);
  for (const r of WORKER_ROLES) assert.deepEqual(claim(r), { token: WORKER_TOKEN });
  assert.throws(() => productionRoleClaim(undefined)("scout"), (e: unknown) => e instanceof WorkerError && e.kind === "config");
});

test("parseBuildArgs extracts --repo and leaves the goal", () => {
  assert.deepEqual(parseBuildArgs(["fix", "the", "bug", "--repo", "/r"]), { repo: "/r", unknownFlags: [], rest: ["fix", "the", "bug"] });
  assert.deepEqual(parseBuildArgs(["g", "--repo=/x"]), { repo: "/x", unknownFlags: [], rest: ["g"] });
  assert.deepEqual(parseBuildArgs(["just", "a", "goal"]), { unknownFlags: [], rest: ["just", "a", "goal"] });
});

test("parseBuildArgs parses --escalate (authorize the frontier consult)", () => {
  assert.deepEqual(parseBuildArgs(["fix", "it", "--escalate"]), { escalate: true, unknownFlags: [], rest: ["fix", "it"] });
  assert.deepEqual(parseBuildArgs(["fix", "it"]).escalate, undefined, "frontier authorization is off by default");
});

test("parseBuildArgs parses --yes / -y (skip the Socratic interview)", () => {
  assert.deepEqual(parseBuildArgs(["fix", "it", "--yes"]), { yes: true, unknownFlags: [], rest: ["fix", "it"] });
  assert.deepEqual(parseBuildArgs(["fix", "it", "-y"]), { yes: true, unknownFlags: [], rest: ["fix", "it"] });
  // absent ⇒ no `yes` key (so callers see undefined, the interview default)
  assert.deepEqual(parseBuildArgs(["fix", "it"]), { unknownFlags: [], rest: ["fix", "it"] });
  // composes with the other flags
  assert.deepEqual(parseBuildArgs(["g", "--repo=/x", "-y", "--cost"]), { repo: "/x", cost: true, yes: true, unknownFlags: [], rest: ["g"] });
});

test("#9: parseBuildArgs COLLECTS unknown flags (not folded into the goal) and honors `--` end-of-options", () => {
  // A typo'd flag is captured, not swallowed into the goal.
  assert.deepEqual(parseBuildArgs(["fix", "it", "--no-promote"]), { unknownFlags: ["--no-promote"], rest: ["fix", "it"] });
  // `--` ends option parsing: a genuine leading-dash goal token survives as text.
  assert.deepEqual(parseBuildArgs(["--", "--weird-goal-token"]), { unknownFlags: [], rest: ["--weird-goal-token"] });
});

test("parseBuildArgs parses --scope (bare ⇒ auto-detect) and --scope=<path> (explicit), never eating the goal", () => {
  // Bare --scope ⇒ "" (auto-detect at repo root); the goal token is NOT consumed as the path.
  assert.deepEqual(parseBuildArgs(["build", "the", "thing", "--scope"]), { scope: "", unknownFlags: [], rest: ["build", "the", "thing"] });
  assert.deepEqual(parseBuildArgs(["g", "--scope=plan/SCOPE.md"]), { scope: "plan/SCOPE.md", unknownFlags: [], rest: ["g"] });
  assert.equal(parseBuildArgs(["g"]).scope, undefined, "staging is off unless requested");
});

test("loadScopePlan: undefined ⇒ not requested; a real SCOPE.md ⇒ ordered stages; missing explicit path ⇒ notFound", async () => {
  assert.deepEqual(await loadScopePlan(undefined, "/repo"), {}, "no --scope ⇒ {} (heuristic path unchanged)");

  const repo = mkdtempSync(tmpJoin(tmpdir(), "ikbi-scope-"));
  writeFileSync(tmpJoin(repo, "SCOPE.md"), "# Scope\n\n1. Core contracts (verify)\n2. Storage domain\n3. CPU domain\n");
  const auto = await loadScopePlan("", repo); // bare flag ⇒ auto-detect at the repo root
  assert.equal(auto.plan?.stages.length, 3, "the repo-root SCOPE.md is auto-detected and parsed");
  assert.equal(auto.plan?.stages[0]?.verify, true, "the (verify) marker survives into the plan");

  // An explicit relative path resolves against the repo too.
  mkdirSync(tmpJoin(repo, ".ikbi"), { recursive: true });
  writeFileSync(tmpJoin(repo, ".ikbi", "STAGES.md"), "- a\n- b\n");
  assert.equal((await loadScopePlan(".ikbi/STAGES.md", repo)).plan?.stages.length, 2, "an explicit path is honored");

  const missing = await loadScopePlan("does-not-exist.md", repo);
  assert.equal(missing.plan, undefined);
  assert.match(missing.notFound ?? "", /not found/, "an explicit missing path reports notFound (caller fails loudly)");
});

// ── --yes SKIPS the blocking Socratic interview (Fix 1) ──────────────────────

test("--yes skips the interactive interview prompt even for an ambiguous goal", () => {
  // "fix it" is maximally ambiguous (vague verb + pronoun + no target) ⇒ would normally
  // trigger the interview. With --yes (and even with interactive:true) the prompt must NOT fire.
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  let promptCalls = 0;
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true, // a TTY would normally prompt …
    prompt: async () => { promptCalls += 1; return ""; },
  });
  return cli.build(["fix", "it", "--yes"]).then(() => {
    assert.equal(promptCalls, 0, "the interview prompt was NOT shown under --yes");
    assert.equal(cap2.exit, undefined, "clean run");
    const summary = JSON.parse(cap2.out); // out is ONLY the summary — no interview text leaked
    assert.equal(summary.outcome, "success");
  });
});

test("without --yes, an interactive session DOES prompt the interview for an ambiguous goal", () => {
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  let promptCalls = 0;
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true,
    prompt: async () => { promptCalls += 1; return ""; }, // user presses Enter ⇒ proceed with original goal
  });
  return cli.build(["fix", "it"]).then(() => {
    assert.equal(promptCalls, 1, "the interview prompt fired once for the ambiguous goal");
    assert.equal(cap2.exit, undefined, "pressing Enter proceeds — clean run");
  });
});

test("a non-interactive session skips the interview without --yes (no hang on piped stdin)", () => {
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  let promptCalls = 0;
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: false, // piped / redirected / CI stdin
    prompt: async () => { promptCalls += 1; return ""; },
  });
  return cli.build(["fix", "it"]).then(() => {
    assert.equal(promptCalls, 0, "no blocking prompt when stdin is not a TTY");
    assert.equal(cap2.exit, undefined, "clean run");
  });
});

// ── THE CHAIN PROOF (injected model via capturing roles + real gate-wall) ────

test("build runs the full 5-role pipeline through the orchestrator with the real gate-wall", () => {
  const { orchestrator, resolveIdentity, cap, gateDecision } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo" });

  return cli.build(["fix", "the", "bug", "--repo", "/repo"]).then(() => {
    assert.equal(cap2.exit, undefined, "clean run");
    assert.deepEqual(cap.seen.map((c) => c.role), ["scout", "builder", "verifier", "critic", "integrator"], "all five roles ran");
    for (const c of cap.seen) assert.equal(c.identity.spawnedFrom, "lead", "each role spawned under the dispatching parent");
    assert.equal(gateDecision()?.allow, true, "the REAL gate-wall evaluated the promote (trusted ⇒ allow)");
    const summary = JSON.parse(cap2.out);
    assert.equal(summary.outcome, "success");
    assert.equal(summary.promoted, true);
    assert.equal(summary.roles.length, 5);
  });
});

// ── #10 CLAMP through the command path (credential wiring cannot escalate) ───

test("a worker credential registered ABOVE the parent is clamped to the parent tier (#10)", () => {
  // Parent "verified" (rank 2); worker "trusted" (rank 1 — MORE trusted). Roles must
  // clamp to the PARENT's "verified", never the worker's nominal "trusted".
  const { orchestrator, resolveIdentity, cap } = realOrchestrator("verified", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo" });

  return cli.build(["do", "the", "thing"]).then(() => {
    assert.equal(cap.seen.length, 5);
    for (const c of cap.seen) {
      assert.equal(c.identity.trustTier, "verified", `role ${c.role} clamped to the parent tier, NOT the worker's "trusted"`);
    }
  });
});

// ── gate denial at promote is a CLEAN outcome (not a crash) ──────────────────

test("a gate-denied promote (probation parent) surfaces a discarded/partial outcome, not a crash", () => {
  const { orchestrator, resolveIdentity, gateDecision } = realOrchestrator("probation", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo" });

  return cli.build(["ship", "it"]).then(() => {
    // H2: a rejected build exits NON-ZERO (so `ikbi build && deploy` won't deploy) — but CLEANLY,
    // via setExit(1), not a thrown crash. (Was previously exit undefined.)
    assert.equal(cap2.exit, 1, "a gate denial exits 1 (not promoted), cleanly — not a crash");
    // Phase 2: rejected outcomes now emit failure detail + next hints on stderr.
    assert.match(cap2.err, /Build REJECTED/, "rejected outcome emits failure detail on stderr");
    assert.equal(gateDecision()?.allow, false, "the real gate-wall DENIED the probation promote");
    const summary = JSON.parse(cap2.out);
    assert.equal(summary.promoted, false, "not promoted");
    assert.notEqual(summary.outcome, "success");
  });
});

test("H2/H3: --json emits ONLY the result JSON on stdout, narrative on stderr, and a failure exits 1", () => {
  const failOrchestrator = {
    run: async (task: WorkerTask): Promise<WorkerResult> => ({
      contractVersion: "1.0.0", taskId: task.taskId, outcome: "failure" as const,
      roles: [{ role: "builder" as const, outcome: "failure" as const, summary: "compile error", detail: { filesWritten: ["a.ts"] } }],
      workspaceId: "ws-json", promoted: false, reason: "compile error",
    }),
  };
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator: failOrchestrator, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
  });
  return cli.build(["--json", "fix it"]).then(() => {
    // stdout is a single clean JSON object — `ikbi build --json | jq` works.
    const parsed = JSON.parse(cap2.out.trim());
    assert.equal(parsed.outcome, "failure");
    assert.equal(parsed.promoted, false);
    assert.equal(parsed.reason, "compile error");
    // Narrative / hints went to stderr, not stdout.
    assert.doesNotMatch(cap2.out, /Build FAILED|→ next|builder/, "stdout carries no narrative");
    assert.match(cap2.err, /Build FAILED/, "the narrative is on stderr");
    // H2: a non-success build exits non-zero.
    assert.equal(cap2.exit, 1, "a failed build exits 1");
  });
});

// ── Phase 2: formatFailureDetail + formatNextHints integration through createWorkerCli ──

test("Phase 2: a failure result surfaces failure detail and next-command hints on stderr", () => {
  const failOrchestrator = {
    run: async (task: WorkerTask): Promise<WorkerResult> => ({
      contractVersion: "1.0.0",
      taskId: task.taskId,
      outcome: "failure" as const,
      roles: [{ role: "builder" as const, outcome: "failure" as const, summary: "compilation error", detail: { filesWritten: ["src/foo.ts"] } }],
      workspaceId: "ws-fail-test",
      promoted: false,
      reason: "compilation error",
    }),
  };
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator: failOrchestrator, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
  });
  return cli.build(["fix the compilation error"]).then(() => {
    // The failure detail section
    assert.match(cap2.err, /Build FAILED/, "failure label is present in stderr");
    assert.match(cap2.err, /builder/, "the failing role is named");
    assert.match(cap2.err, /compilation error/, "the reason/summary is included");
    assert.match(cap2.err, /ws-fail-test/, "the workspace id is surfaced");
    // The next-command hints section
    assert.match(cap2.err, /ikbi diff ws-fail-test/, "diff hint is included");
    assert.match(cap2.err, /ikbi workspace discard ws-fail-test/, "discard hint is included");
    // stdout is still machine-readable JSON
    const summary = JSON.parse(cap2.out);
    assert.equal(summary.outcome, "failure");
  });
});

// ── fail-closed credential checks (no run) ───────────────────────────────────

function countingOrchestrator() {
  const calls: WorkerTask[] = [];
  const orchestrator = {
    run: async (task: WorkerTask): Promise<WorkerResult> => {
      calls.push(task);
      return { contractVersion: "1.0.0", taskId: task.taskId, outcome: "success", roles: [], workspaceId: "w", promoted: true };
    },
  };
  return { orchestrator, calls };
}

test("no operator token ⇒ friendly error, no orchestrator run", () => {
  const oc = countingOrchestrator();
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator: oc.orchestrator, resolveIdentity: makeResolver("trusted", "trusted"), operatorToken: undefined, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1 });
  return cli.build(["x"]).then(() => {
    assert.equal(cap2.exit, 1);
    assert.match(cap2.err, /no operator identity.*IKBI_OPERATOR_TOKEN/);
    assert.equal(oc.calls.length, 0);
  });
});

test("no worker token ⇒ friendly error, no orchestrator run", () => {
  const oc = countingOrchestrator();
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator: oc.orchestrator, resolveIdentity: makeResolver("trusted", "trusted"), operatorToken: OPERATOR_TOKEN, workerToken: undefined, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1 });
  return cli.build(["x"]).then(() => {
    assert.equal(cap2.exit, 1);
    assert.match(cap2.err, /no worker credential.*IKBI_WORKER_TOKEN/);
    assert.equal(oc.calls.length, 0);
  });
});

test("H1: an explicit --repo that does not resolve ⇒ loud error, no run (never silent cwd fallback)", () => {
  const oc = countingOrchestrator();
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator: oc.orchestrator, resolveIdentity: makeResolver("trusted", "trusted"), operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo" });
  // a typo'd alias (non-absolute, not registered) must NOT fall back to cwd
  return cli.build(["fix", "it", "--repo", "zzz-not-a-real-repo-alias"]).then(() => {
    assert.equal(cap2.exit, 1);
    assert.match(cap2.err, /--repo "zzz-not-a-real-repo-alias" did not resolve/);
    assert.equal(oc.calls.length, 0, "no build ran against the wrong directory");
  });
});

test("an empty goal ⇒ usage hint, no run", () => {
  const oc = countingOrchestrator();
  const cap2 = capture();
  const cli = createWorkerCli({ orchestrator: oc.orchestrator, resolveIdentity: makeResolver("trusted", "trusted"), operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN, stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1 });
  return cli.build([]).then(() => {
    assert.equal(cap2.exit, 1);
    assert.match(cap2.err, /needs a goal/);
    assert.equal(oc.calls.length, 0);
  });
});

// ── FIX: createProductionWorker wires commit (the workspace manager has it) ───

test("createProductionWorker wires the workspace manager (commit) + governedExec into the orchestrator", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const src = await readFile(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf8");
  // createProductionWorker passes workspaces (coreWorkspaces, which provides commit) explicitly.
  assert.match(src, /createOrchestrator\(\{[^}]*workspaces: coreWorkspaces/, "the production worker threads the workspace manager (with commit)");
  assert.match(src, /import \{ workspaces as coreWorkspaces \} from "\.\.\/\.\.\/core\/workspace\/index\.js"/, "imports the workspace manager singleton");
});

test("the workspace manager singleton actually provides a commit method (production path has commit)", async () => {
  const { workspaces } = await import("../../core/workspace/index.js");
  assert.equal(typeof workspaces.commit, "function", "coreWorkspaces.commit exists — the orchestrator can commit verified work");
});

// ── M4: a cognition `reject` is surfaced (not silently discarded) under --yes ──

test("M4: under --yes, a cognition `reject` is warned to STDERR (advisory, build proceeds)", () => {
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  let promptCalls = 0;
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true,
    prompt: async () => { promptCalls += 1; return ""; },
    // Force deliberation to REJECT — the historically-discarded signal.
    cognition: { deliberate: async () => ({ decision: "reject", confidence: 0.9, rationale: "goal conflicts with policy", memoryUsed: [] }) },
  });
  return cli.build(["delete", "everything", "--yes"]).then(() => {
    assert.equal(promptCalls, 0, "--yes never prompts");
    // The rejection is surfaced on STDERR (not stdout — stdout stays machine-readable).
    assert.match(cap2.err, /REJECTED/, "the reject was warned, not silently discarded");
    assert.match(cap2.err, /goal conflicts with policy/, "the rationale is included in the warning");
    assert.equal(cap2.out.includes("REJECTED"), false, "the warning did NOT leak onto stdout");
    // Advisory: the build still ran to a clean outcome.
    const summary = JSON.parse(cap2.out);
    assert.equal(summary.outcome, "success", "--yes proceeds past the advisory reject");
  });
});

test("M4: under --yes, the Socratic-interview refinement is NOT produced (interactive-only)", () => {
  // "fix it" is maximally ambiguous — interactively it would emit the "Goal Refinement" interview
  // banner. M4: under --yes refinement is skipped entirely (its output was historically computed
  // then discarded), so NO interview text reaches stdout — stdout stays the clean summary JSON.
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true,
    prompt: async () => "",
    cognition: { deliberate: async () => ({ decision: "answer", confidence: 0.9, rationale: "clear", memoryUsed: [] }) },
  });
  return cli.build(["fix", "it", "--yes"]).then(() => {
    assert.equal(cap2.out.includes("Goal Refinement"), false, "no interview banner produced under --yes");
    assert.equal(cap2.out.includes("I need a bit more clarity"), false, "no interview questions produced under --yes");
    JSON.parse(cap2.out); // stdout is ONLY the machine-readable summary
  });
});

test("M4: under --yes, a non-reject cognition decision emits NO reject warning", () => {
  const { orchestrator, resolveIdentity } = realOrchestrator("trusted", "trusted");
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator, resolveIdentity, operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: true,
    prompt: async () => "",
    cognition: { deliberate: async () => ({ decision: "answer", confidence: 0.9, rationale: "clear", memoryUsed: [] }) },
  });
  return cli.build(["add a readme", "--yes"]).then(() => {
    assert.equal(cap2.err.includes("REJECTED"), false, "no reject warning when deliberation did not reject");
  });
});

// ── MULTI-STEP (step-planner) path: H3 leak / H4 read-only verify / H5 land-ability ──

/** A goal that decomposes into 2 atomic steps (numbered list ⇒ strong separator). */
const MULTI_STEP_GOAL = "1. add the login endpoint\n2. add the logout handler";
/** A benign deliberation so the multi-step tests don't depend on the live cognition layer. */
const benignCognition = { deliberate: async () => ({ decision: "answer" as const, confidence: 1, rationale: "ok", memoryUsed: [] }) };

/**
 * A capturing orchestrator for the multi-step path: records every task passed to run(),
 * reports a clamped autonomy via spawnRole (drives the H5 land-ability check), and can be
 * told to FAIL the first step (drives the H3 discard-on-failure path).
 */
function multiStepOrchestrator(opts: { autoCommit: boolean; failFirstStep?: boolean }) {
  const tasks: WorkerTask[] = [];
  const orchestrator = {
    run: async (task: WorkerTask): Promise<WorkerResult> => {
      tasks.push(task);
      const fail = opts.failFirstStep === true && task.taskId.endsWith(":step1");
      return {
        contractVersion: "1.0.0",
        taskId: task.taskId,
        outcome: fail ? ("failure" as const) : ("success" as const),
        roles: [],
        promoted: false,
        ...(fail ? { reason: "step blew up" } : {}),
      };
    },
    spawnRole: (_role: WorkerRole, _ctx: unknown) => ({ autonomy: autonomyForTier(opts.autoCommit ? "trusted" : "verified") }),
  };
  return { orchestrator, tasks };
}

/** A step-workspace lifecycle fake that counts allocate/discard (no real git). */
function stepWorkspacesFake() {
  const handle = fakeWorkspaceHandle();
  const calls = { allocate: 0, discard: 0 };
  const surface = {
    allocate: async () => { calls.allocate += 1; return handle; },
    discard: async (h: WorkspaceHandle) => { calls.discard += 1; return { workspaceId: h.id, removed: true }; },
  };
  return { handle, calls, surface };
}

// H3: when a step fails, the shared workspace is discarded (no worktree leak).
test("H3: a failed multi-step build DISCARDS the shared workspace (no leak)", () => {
  const { orchestrator, tasks } = multiStepOrchestrator({ autoCommit: true, failFirstStep: true });
  const stepWs = stepWorkspacesFake();
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: false, stepWorkspaces: stepWs.surface, cognition: benignCognition,
  });
  return cli.build([MULTI_STEP_GOAL]).then(() => {
    assert.equal(stepWs.calls.allocate, 1, "the shared workspace was allocated");
    assert.equal(stepWs.calls.discard, 1, "the failed build discarded the shared workspace");
    assert.equal(tasks.length, 1, "broke after the failing step — no final verify pass ran");
    assert.equal(tasks[0]!.taskId.endsWith(":step1"), true, "the one task run was step 1");
  });
});

// H4: the final verify pass runs the builder read-only (writeScope "none") so it cannot corrupt prior work.
test("H4: the final verify step passes writeScope 'none' (cannot modify accumulated work)", () => {
  const { orchestrator, tasks } = multiStepOrchestrator({ autoCommit: true });
  const stepWs = stepWorkspacesFake();
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: false, stepWorkspaces: stepWs.surface, cognition: benignCognition,
  });
  return cli.build([MULTI_STEP_GOAL]).then(() => {
    const verify = tasks.find((t) => t.taskId.endsWith(":verify"));
    assert.ok(verify !== undefined, "the final verify step ran after all steps passed");
    assert.equal(verify!.writeScope, "none", "the verify step is read-only — the builder cannot write/modify files");
    assert.equal(verify!.reuseWorkspace !== undefined, true, "the verify step reuses the accumulated shared workspace");
    // The intermediate steps still accumulate writes (not read-only) — only the final verify is locked down.
    const step1 = tasks.find((t) => t.taskId.endsWith(":step1"));
    assert.notEqual(step1!.writeScope, "none", "intermediate steps remain writable");
  });
});

// H5: a non-autoCommit tier cannot land a multi-step plan — refuse it BEFORE allocating/running.
test("H5: multi-step plan is REFUSED (exit 1, nothing allocated/run) on a tier without autoCommit", () => {
  const { orchestrator, tasks } = multiStepOrchestrator({ autoCommit: false });
  const stepWs = stepWorkspacesFake();
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator, resolveIdentity: makeResolver("verified", "verified"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
    interactive: false, stepWorkspaces: stepWs.surface, cognition: benignCognition,
  });
  return cli.build([MULTI_STEP_GOAL]).then(() => {
    assert.equal(cap2.exit, 1, "the unlandable multi-step plan exits non-zero");
    assert.match(cap2.err, /autoCommit/, "the refusal explains the worker tier lacks autoCommit");
    assert.equal(stepWs.calls.allocate, 0, "no workspace was allocated for a plan that can't land");
    assert.equal(tasks.length, 0, "no step was run — refused before any model call");
  });
});

test("STAGING: a SCOPE.md drives ordered stages; a (verify) stage verifies mid-build, others skip; final verify+promote runs", () => {
  const repo = mkdtempSync(tmpJoin(tmpdir(), "ikbi-stage-"));
  writeFileSync(tmpJoin(repo, "SCOPE.md"), "# Product scope\n\n1. Core contracts (verify)\n2. Storage domain\n3. CPU domain\n");
  const { orchestrator, tasks } = multiStepOrchestrator({ autoCommit: true });
  const stepWs = stepWorkspacesFake();
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => repo,
    interactive: false, stepWorkspaces: stepWs.surface, cognition: benignCognition,
  });
  // Bare --scope ⇒ auto-detect SCOPE.md at the repo (cwd) root; the goal arg is just the umbrella label.
  return cli.build(["build the whole product", "--scope"]).then(() => {
    const stages = tasks.filter((t) => /:step\d+$/.test(t.taskId));
    assert.equal(stages.length, 3, "all 3 SCOPE stages ran");
    assert.deepEqual(stages.map((t) => t.goal), ["Core contracts", "Storage domain", "CPU domain"], "each stage used its OWN goal, not the umbrella label or a heuristic split");
    // The (verify)-marked stage 1 verifies the accumulated state; the others defer to the final pass.
    assert.equal(stages[0]!.skipVerifier, false, "stage 1 (verify) runs the verifier mid-build (catch a broken foundation early)");
    assert.equal(stages[1]!.skipVerifier, true, "an unmarked stage skips intermediate verify (incomplete project)");
    assert.equal(stages[2]!.skipVerifier, true);
    // Every intermediate stage accumulates in the ONE shared workspace and never promotes on its own.
    assert.ok(stages.every((t) => t.reuseWorkspace !== undefined && t.skipPromote === true), "stages accumulate in the shared workspace, no per-stage promote");
    assert.equal(stepWs.calls.allocate, 1, "one shared workspace for the whole staged build");
    const verify = tasks.find((t) => t.taskId.endsWith(":verify"));
    assert.ok(verify !== undefined && verify.writeScope === "none", "a final read-only verify+promote pass ran on the accumulated tree");
  });
});

test("STAGING: an explicit --scope path that is MISSING fails loudly (exit 1, nothing allocated)", () => {
  const repo = mkdtempSync(tmpJoin(tmpdir(), "ikbi-stage-"));
  const { orchestrator, tasks } = multiStepOrchestrator({ autoCommit: true });
  const stepWs = stepWorkspacesFake();
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => repo,
    interactive: false, stepWorkspaces: stepWs.surface, cognition: benignCognition,
  });
  return cli.build(["build it", "--scope=nope/STAGES.md"]).then(() => {
    assert.equal(cap2.exit, 1, "an explicitly-requested but missing scope file fails loudly");
    assert.match(cap2.err, /--scope requested but/, "the error names the missing scope file");
    assert.equal(stepWs.calls.allocate, 0, "nothing was allocated / run");
    assert.equal(tasks.length, 0);
  });
});

test("an unverifiable-target failure renders the actionable 'no runnable checks' diagnostic (not a model-failure)", () => {
  const unverifiableOrchestrator = {
    run: async (task: WorkerTask): Promise<WorkerResult> => ({
      contractVersion: "1.0.0",
      taskId: task.taskId,
      outcome: "failure" as const,
      roles: [{ role: "builder" as const, outcome: "failure" as const, summary: "builder failed" }],
      workspaceId: "ws-unverif",
      promoted: false,
      reason: "unverifiable target (checks_unresolvable): no recognizable project manifest",
      verification: {
        kind: "checks_unresolvable",
        reason: "no recognizable project manifest at or above the worktree",
        nextSteps: [
          "add a project manifest (package.json / pyproject.toml / Cargo.toml / go.mod / project.godot)",
          'run with IKBI_CHECKS="<command>" to declare the checks explicitly',
        ],
      },
    }),
  };
  const cap2 = capture();
  const cli = createWorkerCli({
    orchestrator: unverifiableOrchestrator, resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: cap2.stdout, stderr: cap2.stderr, setExit: cap2.setExit, now: () => 1, cwd: () => "/repo",
  });
  return cli.build(["make a tiny change"]).then(() => {
    assert.match(cap2.err, /could not verify this target because no runnable checks were found/, "explains WHY (no checks)");
    assert.match(cap2.err, /Classification: checks_unresolvable/, "shows the classification");
    assert.match(cap2.err, /Detected:/, "shows what was detected");
    assert.match(cap2.err, /no recognized project manifest or verifier/, "detected: no manifest/verifier");
    assert.match(cap2.err, /no IKBI_CHECKS override/, "detected: no IKBI_CHECKS");
    assert.match(cap2.err, /Next steps:/, "lists actionable next steps");
    assert.match(cap2.err, /IKBI_CHECKS="<command>"/, "one of the next steps is the explicit-check override");
    assert.match(cap2.err, /This is not a model failure\. Escalation was suppressed because a stronger model cannot fix a missing verification contract\./, "states this was not a model failure + why escalation suppressed");
    // stdout stays machine-readable JSON.
    const summary = JSON.parse(cap2.out);
    assert.equal(summary.outcome, "failure");
  });
});

// ── MoE DUEL-ON-FAILURE ─────────────────────────────────────────────────────────

test("MoE duel: primary (deepseek lane) fails → a mimo-lane PEER runs and its promotion is kept", async () => {
  const lanes: (string | undefined)[] = [];
  const fakeOrch = {
    run: async (task: WorkerTask): Promise<WorkerResult> => {
      lanes.push(task.moeVendorLane);
      const promoted = task.moeVendorLane === "mimo"; // deepseek lane fails; mimo lane promotes
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: promoted ? "success" : "failure", roles: [], promoted, ...(promoted ? {} : { reason: "deepseek-lane attempt did not promote" }) } as WorkerResult;
    },
  };
  const out: string[] = [];
  const cli = createWorkerCli({
    orchestrator: fakeOrch,
    resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: (s) => out.push(s), stderr: () => {}, setExit: () => {}, now: () => 1, cwd: () => "/repo",
  });
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]);
  // Primary ran in the deepseek lane and failed; ONE peer ran in the mimo lane and promoted.
  assert.equal(lanes[0], "deepseek", "the primary attempt is pinned to the first vendor lane");
  assert.ok(lanes.includes("mimo"), "a peer attempt ran in the other vendor lane after the primary failed");
  assert.equal(lanes[lanes.length - 1], "mimo", "the last (winning) attempt was the peer");
});

test("MoE duel: a primary that promotes NEVER pays for a second attempt", async () => {
  const lanes: (string | undefined)[] = [];
  const fakeOrch = {
    run: async (task: WorkerTask): Promise<WorkerResult> => {
      lanes.push(task.moeVendorLane);
      return { contractVersion: CONTRACT_VERSION, taskId: task.taskId, outcome: "success", roles: [], promoted: true } as WorkerResult;
    },
  };
  const cli = createWorkerCli({
    orchestrator: fakeOrch,
    resolveIdentity: makeResolver("trusted", "trusted"),
    operatorToken: OPERATOR_TOKEN, workerToken: WORKER_TOKEN,
    stdout: () => {}, stderr: () => {}, setExit: () => {}, now: () => 1, cwd: () => "/repo",
  });
  await cli.build(["fix", "the", "bug", "--repo", "/repo", "--yes", "--tier", "cheap"]);
  assert.deepEqual(lanes, ["deepseek"], "the primary promoted, so no mimo-lane peer was ever spun");
});
