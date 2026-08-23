/**
 * RECOVERY / SESSION TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * Proven through the real built CLI: `ikbi v2 build` runs a BUILD SESSION. `--json` exposes the
 * session structure (id, attempts, recovery decisions); a clean build is one attempt that
 * recovery stops as accepted; and an operator-required condition (a dirty source checkout) stops
 * WITHOUT an endless recapture. The bounded automatic FRESH-ATTEMPT retry across a moved
 * target / timeout / transient provider failure is proven deterministically in-process in
 * `core/session.test.ts` (the fake provider socket scripts a single attempt's turns).
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import { HERMETIC_DEV_KEY_ENV } from "../test-env.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { after, test } from "node:test";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

import { loopbackEgressEnv, startFakeOpenAIProvider, type FakeProviderServer, type ScriptedTurn } from "./fake-provider-server.js";
import { initGitRepo } from "./fixture-repo.js";
import { parseSession, sessionFinalAttempt } from "./session-json.js";

const dirs: string[] = [];
const servers: FakeProviderServer[] = [];
after(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const WIDGET = "export const widget = 1;\n";
const WIDGET_2 = "export const widget = 2;\n";
const GREP_WIDGET_2 = `[{"name":"widget","command":"grep","args":["-q","widget = 2","src/widget.ts"]}]`;
const SATISFIED = JSON.stringify({ verdict: "satisfied", summary: "ok", defects: [] });

const EDIT_TO_2: readonly ScriptedTurn[] = [
  { toolCalls: [{ name: "read_file", args: { path: "src/widget.ts" } }] },
  { toolCalls: [{ name: "replace_file", args: { path: "src/widget.ts", content: WIDGET_2 }, observationFrom: "src/widget.ts" }] },
  { toolCalls: [{ name: "finish_candidate", args: { summary: "set widget to 2", believesComplete: true } }] },
];

async function provider(): Promise<FakeProviderServer> {
  const server = await startFakeOpenAIProvider({ script: EDIT_TO_2, criticResponse: SATISFIED });
  servers.push(server);
  return server;
}

function makeStateRoot(server: FakeProviderServer): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-rstate-"));
  dirs.push(root);
  writeFileSync(
    join(root, "providers.json"),
    JSON.stringify({
      providers: [{ id: "p1", kind: "openai-compatible", baseUrl: server.baseUrl, keyless: true }],
      models: [{ id: "m1", role: "builder", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: [{ provider: "p1", providerModelId: "m1-wire" }], capabilities: { context_window: 100000, supports_tools: true } }],
    }, null, 2),
  );
  return root;
}

function makeRepo(): string {
  const repo = initGitRepo({ "src/widget.ts": WIDGET });
  dirs.push(repo);
  return repo;
}

function runCli(root: string, server: FakeProviderServer, repo: string, json = true) {
  const cwd = mkdtempSync(join(tmpdir(), "ikbi-v2-rcwd-"));
  dirs.push(cwd);
  const args = ["v2", "build", "--allow-repo-wide", "set widget to 2 in src/widget.ts", "--repo", repo];
  if (json) args.push("--json");
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
      // and must not depend on the operator's untracked `.env` to start.
      ...HERMETIC_DEV_KEY_ENV,
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-rhome-")),
      IKBI_STATE_ROOT: root, IKBI_MODEL_DRIVER: "m1", IKBI_MODEL_BUILDER: "m1", IKBI_MODEL_CRITIC: "m1",
      IKBI_CHECKS: GREP_WIDGET_2, ...loopbackEgressEnv(server),
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("recovery truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

test("recovery truth: `ikbi v2 build` runs a BUILD SESSION — --json exposes its structure", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const r = runCli(root, server, makeRepo());
  const session = parseSession(r.stdout);
  assert.match(session.buildSessionId, /^sess_/);
  assert.equal(session.receipt.totalAttempts, 1, "a clean build is a single attempt");
  assert.equal(session.attempts.length, 1);
  assert.equal(session.recoveryDecisions.length, 1);
  assert.equal(session.recoveryDecisions[0]!.kind, "stop_accepted", "recovery stopped it as accepted");
  assert.equal(session.recoveryDecisions[0]!.authorizesNewAttempt, false);
  assert.equal(session.outcome.kind, "accepted");
  // The session's final attempt is the full canonical run.
  const final = sessionFinalAttempt(r.stdout);
  assert.equal(final.receipt.promotion!.publishedTree, final.receipt.candidate!.treeId);
});

test("recovery truth: a DIRTY source stops for an operator — no endless recapture", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();
  writeFileSync(join(repo, "src", "wip.ts"), "operator work in progress\n");
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const r = runCli(root, server, repo);
  const session = parseSession(r.stdout);
  assert.equal(session.receipt.totalAttempts, 1, "a fresh attempt over the same dirt changes nothing");
  assert.equal(session.recoveryDecisions[0]!.kind, "require_operator");
  assert.equal(session.outcome.kind, "withheld");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), headBefore, "nothing landed");
});

test("recovery truth: the human rendering shows the session and the accepted outcome", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const r = runCli(root, server, makeRepo(), false);
  assert.match(r.stdout, /session {5}sess_[0-9a-f-]+ · 1 attempt\(s\)/);
  assert.match(r.stdout, /outcome {5}accepted — promoted/);
});
