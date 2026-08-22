/**
 * VERIFICATION TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * THE ACCEPTANCE CRITERION FOR V2-008, through the real built CLI and real governed
 * execution. A scripted provider drives the builder to produce a candidate; the run then
 * verifies THAT candidate — recomputing its tree, planning operator-declared checks,
 * running them through governed-exec against the candidate worktree, recomputing the tree,
 * and classifying — all with no model call.
 *
 * The full chain, no shortcut:
 *   CLI → builder (scripted provider) → candidate capture → verification
 *       → governed-exec → real `pnpm test` in the candidate worktree → verdict → receipt
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import { HERMETIC_DEV_KEY_ENV } from "../test-env.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { loopbackEgressEnv, startFakeOpenAIProvider, type FakeProviderServer, type ScriptedTurn } from "./fake-provider-server.js";
import { initGitRepo, writeFiles } from "./fixture-repo.js";
import { sessionFinalAttempt } from "./session-json.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

const dirs: string[] = [];
const servers: FakeProviderServer[] = [];

after(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const WIDGET_1 = "export const widget = 1;\n";
const WIDGET_2 = "export const widget = 2;\n";

/** A READ-ONLY, allowlisted check: passes iff the edited value is present. No mutation. */
const GREP_WIDGET_2 = `[{"name":"widget","command":"grep","args":["-q","widget = 2","src/widget.ts"]}]`;

/** The builder's turns for a one-line edit to `widget = 2`. */
const EDIT_TO_2: readonly ScriptedTurn[] = [
  { toolCalls: [{ name: "read_file", args: { path: "src/widget.ts" } }] },
  { toolCalls: [{ name: "replace_file", args: { path: "src/widget.ts", content: WIDGET_2 }, observationFrom: "src/widget.ts" }] },
  { toolCalls: [{ name: "finish_candidate", args: { summary: "set widget to 2", believesComplete: true } }] },
];

async function provider(script: readonly ScriptedTurn[]): Promise<FakeProviderServer> {
  const server = await startFakeOpenAIProvider({ script });
  servers.push(server);
  return server;
}

function makeStateRoot(server: FakeProviderServer): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-vstate-"));
  dirs.push(root);
  writeFileSync(
    join(root, "providers.json"),
    JSON.stringify(
      {
        providers: [{ id: "p1", kind: "openai-compatible", baseUrl: server.baseUrl, keyless: true }],
        models: [
          {
            id: "m1",
            role: "builder",
            cost: { promptPerMTok: 0, completionPerMTok: 0 },
            providers: [{ provider: "p1", providerModelId: "m1-wire" }],
            capabilities: { context_window: 100000, supports_tools: true },
          },
        ],
      },
      null,
      2,
    ),
  );
  return root;
}

/** A git fixture repo with a package.json (for check discovery) and the widget file. */
function makeRepo(files: Readonly<Record<string, string>> = {}): string {
  const repo = initGitRepo({
    ".gitignore": "node_modules/\n*.log\n",
    "package.json": JSON.stringify({ name: "fx", scripts: { test: "node -e \"process.exit(0)\"" } }),
    "src/widget.ts": WIDGET_1,
    ...files,
  });
  dirs.push(repo);
  return repo;
}

function build(root: string, server: FakeProviderServer, repo: string, ikbiChecks?: string, extraEnv: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [ENTRY, "v2", "build", "set widget to 2 in src/widget.ts", "--repo", repo, "--json"], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-vcwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
      // and must not depend on the operator's untracked `.env` to start.
      ...HERMETIC_DEV_KEY_ENV,
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-vhome-")),
      IKBI_STATE_ROOT: root,
      IKBI_MODEL_DRIVER: "m1",
      IKBI_MODEL_BUILDER: "m1",
      IKBI_MODEL_CRITIC: "m1",
      IKBI_RECOVERY_MAX_ATTEMPTS: "1",
      ...(ikbiChecks !== undefined ? { IKBI_CHECKS: ikbiChecks } : {}),
      ...extraEnv,
      ...loopbackEgressEnv(server),
    },
    encoding: "utf8",
  });
  assert.ok(res.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${res.stdout}\n---\n${res.stderr}`);
  return sessionFinalAttempt(res.stdout);
}

/** Build with the standard edit-to-2 script and a widget-is-2 check. */
async function verifyRun(over: { files?: Record<string, string>; checks?: string; script?: readonly ScriptedTurn[]; env?: Record<string, string> } = {}) {
  const server = await provider(over.script ?? EDIT_TO_2);
  const root = makeStateRoot(server);
  const repo = makeRepo(over.files ?? {});
  const checks = over.checks ?? GREP_WIDGET_2;
  const result = build(root, server, repo, checks, over.env ?? {});
  return { server, root, repo, result };
}



test("verification truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── NORMAL PASS ──────────────────────────────────────────────────────────────

test("verification truth: a candidate whose checks PASS is verified PASS, tree unchanged", async () => {
  // Operator declares a check that passes on the candidate. `node` is not default-
  // allowlisted, so run it through `pnpm test`; the fixture's test script greps widget.
  const server = await provider(EDIT_TO_2);
  const root = makeStateRoot(server);
  // A READ-ONLY, allowlisted check: `grep -q` for the edited value. It cannot mutate the
  // worktree, so a PASS is a clean tree. (pnpm-based checks write pnpm-lock.yaml, which the
  // mutation guard correctly catches — see the check-mutation test.)
  const repo = makeRepo();
  const result = build(root, server, repo, GREP_WIDGET_2);

  const v = result.receipt.verification;
  assert.ok(v !== undefined, `no verification: ${JSON.stringify(result.outcome)}`);
  assert.equal(v.verdict, "pass");
  assert.equal(v.treeUnchanged, true, "the checks did not change the candidate tree");
  assert.equal(v.candidateTreeId, result.receipt.candidate!.treeId, "verification is bound to the candidate's exact tree");
  assert.equal(v.checks[0]?.status, "pass");
  assert.equal(v.checks[0]?.exitCode, 0);

  // PASS + satisfied on a CLEAN repo ⇒ eligible, adjudicated, and PUBLISHED — the run is
  // accepted and the candidate tree lands on the target branch.
  assert.ok(result.outcome.kind === "accepted");
  assert.equal(result.receipt.disposition?.decision, "acceptable_for_promotion");
  assert.equal(result.receipt.stagesEntered.includes("promotion"), true);
  assert.equal(result.receipt.evidence.verificationsPerformed, 1);
  assert.equal(result.receipt.evidence.promoted, true);
  assert.equal(result.receipt.promotion?.publishedTree, result.receipt.candidate!.treeId, "the EXACT verified tree landed");
});

// ── NORMAL FAIL ──────────────────────────────────────────────────────────────

test("verification truth: a candidate whose checks FAIL is verified FAIL, retained, not promoted", async () => {
  // The builder edits to 2, but the check demands widget = 3 → non-zero exit → FAIL.
  const result = (await verifyRun({ checks: `[{"name":"test","command":"grep","args":["-q","widget = 3","src/widget.ts"]}]` })).result;
  const v = result.receipt.verification!;
  assert.equal(v.verdict, "fail");
  assert.equal(v.checks[0]?.status, "fail");
  assert.notEqual(v.checks[0]?.exitCode, 0);
  assert.equal(v.workspaceDisposition, "retained", "a failed candidate is kept for recovery/forensics");
  assert.equal(result.receipt.evidence.promoted, false);
  // No repair, no builder re-entry: exactly the builder's turns, no more.
  assert.equal(result.receipt.evidence.invocations, 4, "V2-009: three builder turns AND the critic's one judgment");
});

// ── NO CHECKS ────────────────────────────────────────────────────────────────

test("verification truth: a repo with no resolvable checks is NO_CHECKS, not PASS", async () => {
  const server = await provider(EDIT_TO_2);
  const root = makeStateRoot(server);
  // No package.json, no manifest, no IKBI_CHECKS → resolveChecks fails closed.
  const repo = initGitRepo({ "src/widget.ts": WIDGET_1 });
  dirs.push(repo);
  const result = build(root, server, repo);
  const v = result.receipt.verification!;
  assert.equal(v.verdict, "no_checks");
  assert.notEqual(v.verdict, "pass");
  assert.equal(v.checks.length, 0, "no command was invented");
});

// ── CHECK-MUTATION HOSTILE ───────────────────────────────────────────────────

test("verification truth: a green check that MUTATES the workspace is workspace_mutated_by_checks", async () => {
  // The check exits 0 but writes a new file into the candidate worktree. The tree after
  // the checks no longer equals the candidate — the verdict is about the tree, not exit 0.
  const mutatingCheck = "require('fs').writeFileSync('injected-by-check.txt','x'); process.exit(0)";
  const server = await provider(EDIT_TO_2);
  const root = makeStateRoot(server);
  const repo = initGitRepo({
    ".gitignore": "node_modules/\n*.log\n",
    "package.json": JSON.stringify({ name: "fx", scripts: { test: `node -e "${mutatingCheck.replace(/"/g, '\\"')}"` } }),
    "src/widget.ts": WIDGET_1,
  });
  dirs.push(repo);
  const result = build(root, server, repo, `[{"name":"test","command":"pnpm","args":["test"]}]`);

  const v = result.receipt.verification!;
  assert.equal(v.verdict, "workspace_mutated_by_checks", "a check that changes its subject verifies nothing");
  assert.equal(v.treeUnchanged, false);
  assert.equal(v.checks[0]?.status, "pass", "the check exited 0 — and it still does not count");
  assert.notEqual(v.treeBeforeChecks, v.treeAfterChecks);
});

// ── TIMEOUT ──────────────────────────────────────────────────────────────────

test("verification truth: a hanging check is TIMEOUT, not FAIL, and the process is killed", async () => {
  // `tail -f /dev/null` hangs forever — allowlisted and read-only, so the only thing that
  // ends it is the timeout kill.
  const result = (await verifyRun({ checks: `[{"name":"test","command":"tail","args":["-f","/dev/null"]}]`, env: { IKBI_CHECK_TIMEOUT_MS: "2000" } })).result;
  const v = result.receipt.verification!;
  assert.equal(v.verdict, "timeout");
  assert.equal(v.checks[0]?.status, "timeout");
});

// ── INFRASTRUCTURE FAILURE ───────────────────────────────────────────────────

test("verification truth: a non-allowlisted check binary is INFRASTRUCTURE_FAILURE, not FAIL", async () => {
  const result = (await verifyRun({ checks: `[{"name":"test","command":"definitely-not-allowlisted-xyz","args":[]}]` })).result;
  const v = result.receipt.verification!;
  assert.equal(v.verdict, "infrastructure_failure", "a check that never launched is not the candidate's fault");
  assert.equal(v.checks[0]?.status, "infrastructure_failure");
  assert.equal(v.checks[0]?.exitCode, null);
});

// ── MULTI-CHECK DETERMINISM ──────────────────────────────────────────────────

test("verification truth: multiple checks run in order, and the plan/verdict are deterministic", async () => {
  const checks = `[{"name":"a","command":"grep","args":["-q","widget = 2","src/widget.ts"]},{"name":"b","command":"grep","args":["-q","widget","src/widget.ts"]}]`;
  const a = (await verifyRun({ checks })).result;
  const b = (await verifyRun({ checks })).result;
  assert.equal(a.receipt.verification!.checks.length, 2);
  assert.deepEqual(a.receipt.verification!.checks.map((c) => c.name), ["a", "b"], "plan order preserved");
  assert.equal(a.receipt.verification!.planId, b.receipt.verification!.planId, "plan id is stable");
  assert.equal(a.receipt.verification!.verdict, b.receipt.verification!.verdict, "verdict is deterministic");
});

// ── DIRTY-SNAPSHOT CANDIDATE ─────────────────────────────────────────────────

test("verification truth: a candidate built from a DIRTY snapshot verifies the candidate, not HEAD", async () => {
  const server = await provider(EDIT_TO_2);
  const root = makeStateRoot(server);
  const repo = makeRepo({ "src/other.ts": "export const other = 1;\n" });
  // Operator's uncommitted work — the snapshot is dirty; the candidate = dirty state + edit.
  writeFiles(repo, { "src/other.ts": "export const other = 999; // operator WIP\n" });

  const result = build(root, server, repo, GREP_WIDGET_2);
  assert.equal(result.receipt.sourceSnapshot!.clean, false);
  const v = result.receipt.verification!;
  assert.equal(v.verdict, "pass", "the check ran against the candidate tree — widget IS 2 there");
  assert.equal(v.candidateTreeId, result.receipt.candidate!.treeId);
  assert.equal(v.treeUnchanged, true);
});

// ── RECEIPT / AUDIT TRUTH ────────────────────────────────────────────────────

test("verification truth: the receipt binds the verification to the candidate, with no log dump", async () => {
  const result = (await verifyRun()).result;
  const v = result.receipt.verification!;
  assert.match(v.verificationId, /^[0-9a-f]{64}$/, "content-addressed id");
  assert.equal(v.candidateId, result.receipt.candidate!.candidateId);
  assert.equal(v.runId, result.runId);
  assert.ok(v.planId.length > 0);
  for (const c of v.checks) {
    assert.ok(c.outputSha256.length === 64, "output is hashed");
    assert.ok(c.outputExcerpt.length <= 1500, "excerpt is bounded — no giant log in the receipt");
  }
  // No raw multi-KB body smuggled anywhere in the receipt.
  assert.ok(JSON.stringify(result.receipt).length < 20_000, "the receipt stays small");
});

test("verification truth: the same candidate + plan yields the SAME verification id", async () => {
  const a = (await verifyRun()).result;
  const b = (await verifyRun()).result;
  assert.equal(a.receipt.candidate!.candidateId, b.receipt.candidate!.candidateId, "same candidate");
  assert.equal(a.receipt.verification!.verificationId, b.receipt.verification!.verificationId, "same verification");
});

test("verification truth: the human rendering states the verdict and refuses to imply promotion", async () => {
  const server = await provider(EDIT_TO_2);
  const root = makeStateRoot(server);
  const repo = makeRepo();
  const res = spawnSync(process.execPath, [ENTRY, "v2", "build", "set widget to 2 in src/widget.ts", "--repo", repo], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-vcwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
      // and must not depend on the operator's untracked `.env` to start.
      ...HERMETIC_DEV_KEY_ENV,
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-vhome-")),
      IKBI_STATE_ROOT: root, IKBI_MODEL_DRIVER: "m1", IKBI_MODEL_BUILDER: "m1", IKBI_MODEL_CRITIC: "m1",
      IKBI_RECOVERY_MAX_ATTEMPTS: "1",
      IKBI_CHECKS: GREP_WIDGET_2, ...loopbackEgressEnv(server),
    },
    encoding: "utf8",
  });
  assert.match(res.stdout, /verified {4}PASS · 1 check\(s\)/);
  assert.match(res.stdout, /pass +widget \(grep/);
  assert.match(res.stdout, /VERIFIED — deterministic evidence for adjudication/);
  // PASS + satisfied on a clean repo ⇒ ELIGIBLE, then PUBLISHED. The render states the landing.
  assert.match(res.stdout, /disposition ELIGIBLE FOR PROMOTION/);
  assert.match(res.stdout, /promotion {3}PUBLISHED · /);
  assert.match(res.stdout, /the exact candidate tree is now authoritative/);
});
