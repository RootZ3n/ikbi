/**
 * INVOCATION TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * The first slice in which a real model call happens, so this is the suite that has to
 * prove ikbi can say, of an actual HTTP request that actually left the process:
 *
 *   this is what the operator requested, this is the exact route we authorized,
 *   this is the exact provider/model we sent, this is what the provider says served
 *   it, this is the exact context package it received — and nothing else happened.
 *
 * The provider is a REAL protocol-faithful HTTP server on loopback, in its own process.
 * The real v1 transport speaks to it over a real socket, so this exercises the whole
 * production path — CLI → policy → resolver → context → InvocationAuthority → transport
 * → wire → normalized response → lifecycle evidence → receipt — without spending money
 * or touching the internet.
 *
 * Reaching loopback requires an explicit egress opt-in; the SSRF floor is not bypassed.
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

import { loopbackEgressEnv, startFakeOpenAIProvider, type FakeProviderOptions, type FakeProviderServer } from "./fake-provider-server.js";
import { initGitRepo, writeFiles } from "./fixture-repo.js";
import { sessionFinalAttempt } from "./session-json.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

/** A credential that must never surface. The roster gives it to the `keyed` provider. */
const PLANTED_SECRET = "sk-live-INVOCATIONMUSTNEVERPRINTTHIS";

const MARKER = "MARKER-context-reached-the-model";
const GOAL = "acknowledge src/widget.ts";

const servers: FakeProviderServer[] = [];
const dirs: string[] = [];

async function provider(options: FakeProviderOptions = {}): Promise<FakeProviderServer> {
  const server = await startFakeOpenAIProvider(options);
  servers.push(server);
  return server;
}

/** Two profiles pinning two different wire model ids on the same live endpoint. */
function roster(server: FakeProviderServer): unknown {
  const caps = { context_window: 100000, supports_tools: true };
  const zero = { promptPerMTok: 0, completionPerMTok: 0 };
  return {
    providers: [
      { id: "p1", kind: "openai-compatible", baseUrl: server.baseUrl, keyless: true },
      { id: "p2", kind: "openai-compatible", baseUrl: server.baseUrl, keyless: true },
      { id: "keyed", kind: "openai-compatible", baseUrl: server.baseUrl, apiKey: PLANTED_SECRET },
    ],
    models: [
      { id: "alpha", role: "builder", cost: zero, providers: [{ provider: "p1", providerModelId: "alpha-v1" }], capabilities: caps },
      { id: "beta", role: "builder", cost: zero, providers: [{ provider: "p2", providerModelId: "beta-v1" }], capabilities: caps },
      { id: "keyed-model", role: "builder", cost: zero, providers: [{ provider: "keyed", providerModelId: "keyed-v1" }], capabilities: caps },
    ],
  };
}

const profileFor = (name: string, provider_: string, model: string) => ({
  name,
  roles: { builder: { provider: provider_, model }, critic: { provider: provider_, model } },
});

function makeStateRoot(server: FakeProviderServer): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-invstate-"));
  dirs.push(root);
  mkdirSync(join(root, "profiles"), { recursive: true });
  writeFileSync(join(root, "providers.json"), JSON.stringify(roster(server), null, 2));
  for (const p of [profileFor("prof-a", "p1", "alpha"), profileFor("prof-b", "p2", "beta"), profileFor("prof-keyed", "keyed", "keyed-model")]) {
    writeFileSync(join(root, "profiles", `${p.name}.json`), JSON.stringify(p, null, 2));
  }
  return root;
}

function makeRepo(): string {
  // A REAL git repository, fully committed — the canonical path now allocates a worktree.
  const repo = initGitRepo({ "AGENTS.md": `# conventions\n${MARKER}\n`, "src/widget.ts": "export const widget = 1;\n" });
  dirs.push(repo);
  return repo;
}

function runCli(server: FakeProviderServer, root: string, args: readonly string[], extraEnv: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-invcwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      // Hermetic trust material, injected explicitly: a sanitized child inherits no shell,
      // and must not depend on the operator's untracked `.env` to start.
      ...HERMETIC_DEV_KEY_ENV,
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-invhome-")),
      IKBI_STATE_ROOT: root,
      // This suite exercises the INVOCATION AUTHORITY in isolation (one attempt). Recovery's
      // session-level retry of a transient provider failure is proven in the recovery suites.
      IKBI_RECOVERY_MAX_ATTEMPTS: "1",
      ...loopbackEgressEnv(server),
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function v2Run(server: FakeProviderServer, root: string, repo: string, args: readonly string[] = [], extraEnv: Record<string, string> = {}) {
  const r = runCli(server, root, ["v2", "build", GOAL, "--repo", repo, "--json", ...args], extraEnv);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return { result: sessionFinalAttempt(r.stdout), stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const activate = (server: FakeProviderServer, root: string, name: string): void => {
  const r = runCli(server, root, ["profile", "use", name]);
  assert.equal(r.status, 0, `activating ${name} failed:\n${r.stdout}\n${r.stderr}`);
};

after(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("invocation truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── the real call ───────────────────────────────────────────────────────────

test("invocation truth: a REAL request reaches the provider carrying the authorized route and the context", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();
  activate(server, root, "prof-a");

  const { result, status } = v2Run(server, root, repo);
  // The candidate is adjudicated and withheld (nothing promoted) — a correct, intended
  // result, so the exit code is 0. What matters here is what reached the wire.
  assert.ok(result.outcome.kind === "withheld", "the run adjudicates and withholds");
  assert.equal(status, 0);

  // What the SERVER actually received — not what the CLI says it sent.
  const received = await server.received();
  const calls = received.filter((r) => r.path.includes("chat/completions"));
  // Two outbound calls: the builder (with tools) and the critic (no tools). No retry.
  assert.equal(calls.length, 2, "one builder call, one critic call — no retry, no fallback");
  const builderCall = calls.find((c) => c.toolNames.length > 0)!;
  assert.equal(builderCall.wireModelId, "alpha-v1", "the authorized WIRE id, not the logical model id");
  assert.equal(builderCall.method, "POST");

  // The context really travelled — the repository marker is in the request body.
  const body = (calls[0]?.messages ?? []).map((m) => m.content).join("\n");
  assert.ok(body.includes(MARKER), "the AGENTS.md artifact reached the model");
  assert.ok(body.includes(GOAL), "so did the operator's goal");

  // And the run's own account agrees, identity by identity.
  const inv = result.receipt.invocations[0]!;
  assert.equal(inv.authorizedModelId, "alpha");
  assert.equal(inv.sentProviderId, "p1");
  assert.equal(inv.sentProviderModelId, "alpha-v1");
  assert.equal(inv.servedModelId, "alpha-v1");
  assert.equal(inv.identityStatus, "match");
  assert.equal(inv.attempts, 1);
  assert.equal(inv.resolutionDecisionId, result.decision!.decisionId);
  assert.equal(inv.contextPackageId, result.context!.packageId);
  assert.equal(result.invocations[0]?.runId, result.runId);
});

test("invocation truth: the provider reported usage is carried, not estimated", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  const { result } = v2Run(server, root, makeRepo());
  assert.deepEqual(result.receipt.invocations[0]?.usage, { promptTokens: 42, completionTokens: 7, totalTokens: 49 });
});

test("invocation truth: switching the profile changes the WIRE model actually sent", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();

  activate(server, root, "prof-a");
  v2Run(server, root, repo);
  activate(server, root, "prof-b");
  v2Run(server, root, repo);

  const calls = (await server.received()).filter((r) => r.path.includes("chat/completions"));
  // Each run makes a builder call (with tools) and a critic call; the BUILDER call is the
  // one whose wire model the operator's strategy decides.
  const builderCalls = calls.filter((c) => c.toolNames.length > 0);
  assert.deepEqual(builderCalls.map((c) => c.wireModelId), ["alpha-v1", "beta-v1"], "the operator's strategy decided what left the process");
});

// ── the identity hostile cases ──────────────────────────────────────────────

test("identity CASE A: an exact served report is a MATCH", async () => {
  const server = await provider({ servedModelId: "alpha-v1" });
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  const { result } = v2Run(server, root, makeRepo());
  assert.equal(result.receipt.invocations[0]?.identityStatus, "match");
  assert.equal(result.receipt.invocations[0]?.servedModelId, "alpha-v1");
});

test("identity CASE B: a DECLARED alias is an ALIASED_MATCH", async () => {
  // The production alias table is empty on purpose, so this case is proven against the
  // classifier the authority uses, with the relation declared explicitly.
  const { classifyServedIdentity } = await import("../core/invocation.js");
  assert.equal(
    classifyServedIdentity("p1", "alpha-v1", "alpha-v1-20260801", [
      { providerId: "p1", sent: "alpha-v1", served: "alpha-v1-20260801", note: "declared for this test" },
    ]),
    "aliased_match",
  );
  // And through the real CLI, the SAME response with NO declared relation is a mismatch.
  const server = await provider({ servedModelId: "alpha-v1-20260801" });
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  const { result } = v2Run(server, root, makeRepo());
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "invocation.served_identity_mismatch", "undeclared is never 'close enough'");
});

test("identity CASE C: a different served model FAILS and preserves every fact", async () => {
  const server = await provider({ servedModelId: "beta-v9" });
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  const { result, status } = v2Run(server, root, makeRepo());
  assert.notEqual(status, 0);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "provider");
  assert.equal(result.outcome.failure.code, "invocation.served_identity_mismatch");
  assert.equal(result.outcome.failure.detail?.authorizedModelId, "alpha");
  assert.equal(result.outcome.failure.detail?.sentProviderModelId, "alpha-v1");
  assert.equal(result.outcome.failure.detail?.servedModelId, "beta-v9");
  assert.equal(result.invocations[0], undefined, "a mismatched call yields no successful record");
  assert.equal(result.receipt.evidence.providerInvoked, true, "but the provider WAS contacted");
});

test("identity CASE D: a response with NO model is NOT_REPORTED, never fabricated", async () => {
  const server = await provider({ servedModelId: null });
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  const { result } = v2Run(server, root, makeRepo());
  const inv = result.receipt.invocations[0]!;
  assert.equal(inv.identityStatus, "not_reported");
  assert.equal(inv.servedModelId, null, "absent, not backfilled from what was sent");
  assert.equal(inv.sentProviderModelId, "alpha-v1", "while what WAS sent is still recorded");
});

// ── structured failures ─────────────────────────────────────────────────────

test("failure: a 4xx is recorded as the provider REJECTING the request", async () => {
  const server = await provider({ status: 400 });
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  const { result } = v2Run(server, root, makeRepo());
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "invocation.provider_rejected_request");
  assert.equal(result.receipt.evidence.providerInvoked, true, "it reached the wire");
});

test("failure: a 500 is a transport failure, and is NOT retried", async () => {
  const server = await provider({ status: 500 });
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  const { result } = v2Run(server, root, makeRepo());
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "invocation.transport_failure");
  const calls = (await server.received()).filter((r) => r.path.includes("chat/completions"));
  assert.equal(calls.length, 1, "one attempt only — no application retry, no fallback provider");
});

test("failure: a malformed response is a malformed-response failure, not a crash", async () => {
  const server = await provider({ bodyOverride: { nonsense: true } });
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  const { result, stdout } = v2Run(server, root, makeRepo());
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "invocation.malformed_provider_response");
  assert.equal(/\n\s+at\s+\S/.test(stdout), false, "no stack trace leaked");
});

test("failure: an unreachable provider fails WITHOUT counting as an invocation", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();
  // Point the roster at a port nothing is listening on, and allow it through egress so
  // the refusal comes from the socket rather than from the guard.
  const dead = { ...(roster(server) as { providers: { id: string; baseUrl: string }[] }) };
  writeFileSync(
    join(root, "providers.json"),
    JSON.stringify({
      ...(dead as object),
      providers: (dead.providers as Record<string, unknown>[]).map((p) => ({ ...p, baseUrl: `http://127.0.0.1:${server.port + 1}/v1` })),
    }),
  );
  activate(server, root, "prof-a");
  const { result } = v2Run(server, root, repo, [], { IKBI_EGRESS_ALLOW_LOCAL: `127.0.0.1:${server.port},127.0.0.1:${server.port + 1}` });
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "provider");
});

// ── boundaries ──────────────────────────────────────────────────────────────

test("invocation truth: the egress floor is NOT bypassed — loopback needs an opt-in", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  activate(server, root, "prof-a");
  // Same everything, minus the operator's explicit local allowance.
  const r = runCli(server, root, ["v2", "build", GOAL, "--repo", makeRepo(), "--json"], {
    IKBI_EGRESS_ALLOWLIST: "",
    IKBI_EGRESS_ALLOW_LOCAL: "",
  });
  const result = sessionFinalAttempt(r.stdout);
  assert.ok(result.outcome.kind === "failed", "the SSRF floor still applies to v2");
  assert.equal(result.invocations[0], undefined);
});

test("invocation truth: nothing is built, verified or written", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();
  activate(server, root, "prof-a");
  const before = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout;
  const { result } = v2Run(server, root, repo);
  const e = result.receipt.evidence;
  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition"]);
  assert.equal(e.providerInvoked, true);
  assert.equal(e.invocations, 2, "V2-009: the builder call AND the critic call");
  assert.equal(e.candidatesCreated, 1, "no candidate was created");
  assert.equal(e.verificationsPerformed, 1, "V2-008: the candidate WAS verified (no_checks)");
  assert.equal(e.promoted, false);
  assert.equal(e.sourceRepositoryMutated, false);
  assert.ok(result.outcome.kind === "withheld", "the candidate is adjudicated and withheld — nothing promoted");
  assert.equal(result.receipt.stagesEntered.includes("promotion"), false, "the run stops before promotion");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout, before, "the repo is untouched");
});

test("invocation truth: context is not reread — only the package's artifacts travel", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  const repo = makeRepo();
  // A file the goal does not name and no source offers must not appear on the wire.
  writeFiles(repo, { "src/unrelated.ts": "export const secretish = 'NEVER-SENT-MARKER';\n" });
  activate(server, root, "prof-a");
  v2Run(server, root, repo);
  const body = (await server.received()).flatMap((r) => r.messages.map((m) => m.content)).join("\n");
  assert.equal(body.includes("NEVER-SENT-MARKER"), false, "invocation reads no repository file of its own");
  assert.ok(body.includes(MARKER), "only what the assembler authorized travelled");
});

// ── secrets ─────────────────────────────────────────────────────────────────

test("secrets: a provider credential never appears in output, the record, or an error", async () => {
  const server = await provider();
  const root = makeStateRoot(server);
  activate(server, root, "prof-keyed");
  const { result, stdout, stderr } = v2Run(server, root, makeRepo());
  for (const [what, text] of [["stdout", stdout], ["stderr", stderr], ["result", JSON.stringify(result)]] as const) {
    assert.equal(text.includes(PLANTED_SECRET), false, `the planted key leaked into ${what}`);
  }
  // The credential WAS used — the server saw an auth header — and still never came back.
  const calls = (await server.received()).filter((r) => r.path.includes("chat/completions"));
  assert.equal(calls[0]?.hadAuthorization, true, "the transport did authenticate");
  assert.equal(result.receipt.invocations[0]?.sentProviderId, "keyed");
});

test("secrets: a credential does not leak through a provider ERROR either", async () => {
  const server = await provider({ status: 401 });
  const root = makeStateRoot(server);
  activate(server, root, "prof-keyed");
  const { result, stdout, stderr } = v2Run(server, root, makeRepo());
  assert.ok(result.outcome.kind === "failed");
  for (const text of [stdout, stderr, JSON.stringify(result)]) {
    assert.equal(text.includes(PLANTED_SECRET), false, "the key leaked through a failure path");
  }
});
