/**
 * Codex blocker 3 — REPL `/apply` must route through the SAME gate-wall decision path production
 * build uses (no UI path weaker than build). The operator typed `/apply` (intent), but a gate DENY
 * still blocks the promote and EVERY decision (allow or deny) produces a durable gate receipt.
 *
 * These drive the real frozen-core workspace manager through the managed `/apply` lifecycle with a
 * REAL gate-wall whose receipt sink + config are injected, so we can both (a) deny and prove nothing
 * lands and (b) allow and prove the promote still works — each with its decision receipt asserted.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "../egress/index.js";
import { pino } from "pino";

import type { AgentIdentity } from "../../core/identity/contract.js";
import { LockManager } from "../../core/substrate/lock.js";
import { DocumentStore } from "../../core/substrate/store.js";
import type { WorkspaceRecord } from "../../core/workspace/contract.js";
import { runGit } from "../../core/workspace/git.js";
import { WorkspaceManager } from "../../core/workspace/manager.js";
import { createGateWall, gateWallConfig } from "../gate-wall/index.js";
import type { RoleFn } from "../worker-model/contract.js";
import { allocateSessionWorkspace } from "./repl-workspace.js";
import { ChatSession } from "./session.js";

const silent = pino({ level: "silent" });

const passVerifier: RoleFn = async () => ({
  role: "verifier", outcome: "success", summary: 'verification PASSED for scope "impact"',
  detail: { verdict: "pass", verificationMode: "ladder", verificationScope: "impact", checks: [{ name: "tsc", exitCode: 0 }, { name: "test", exitCode: 0 }], stagesRun: ["package-checks"], receipts: ["GREEN for scope: impact"] },
});

type Invoke = ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
function writeThenStop(path: string, content: string): Invoke {
  const responses = [
    { contractVersion: "1.1.0", model: "m", provider: "p", providerModelId: "m", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [], content: "", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path, content }) }] },
    { contractVersion: "1.1.0", model: "m", provider: "p", providerModelId: "m", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } }, latencyMs: 1, fellBack: false, attempts: [], content: "done", finishReason: "stop" },
  ];
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]) as unknown as Invoke;
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-gw-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}
function makeManager(): { mgr: WorkspaceManager; root: string } {
  const root = join(tmpdir(), `ikbi-gw-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  return { mgr: new WorkspaceManager({ root, max: 32, locks, store, logger: silent }), root };
}
/** A gate-wall whose decision receipts are captured (proves the durable decision trail). */
function recordingGateWall(opts: { enabled: boolean }) {
  const receipts: Array<{ operation: string; metadata?: Record<string, unknown> }> = [];
  const gw = createGateWall({
    config: { ...gateWallConfig, enabled: opts.enabled },
    receipts: { append: async (input: unknown, _id: AgentIdentity) => { receipts.push(input as { operation: string; metadata?: Record<string, unknown> }); return {}; } },
    publish: () => {},
  });
  return { gw, receipts };
}
async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
}

test("/apply: a DENYING gate decision blocks the promote and records a deny receipt", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  const { gw, receipts } = recordingGateWall({ enabled: false }); // a disabled gate DENIES (fail-closed)
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "gw-deny", manager: mgr, verifier: passVerifier, gateWall: gw });
    const s = new ChatSession("gw-deny", { workspace: ws, invoke: writeThenStop("denied.ts", "no land\n") });
    await s.send("add a file");

    const r = await s.apply("repl: try to land");
    assert.equal(r.applied, false, "a gate denial blocks /apply");
    assert.equal(r.promote?.promoted, false);
    assert.match(r.summary, /gate-wall denied/i);
    // The target repo never changed.
    assert.ok(!existsSync(join(repo, "denied.ts")), "nothing landed in the target on deny");
    // A durable gate DECISION receipt exists, carrying the deny verdict.
    const decision = receipts.find((x) => x.operation === "gate.evaluate");
    assert.ok(decision !== undefined, "the gate produced a decision receipt");
    assert.equal(decision?.metadata?.allow, false, "the recorded decision is a DENY");
  } finally {
    await cleanup(repo, root);
  }
});

test("/apply: an ALLOWING gate decision still promotes, with a gate approval receipt", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  const { gw, receipts } = recordingGateWall({ enabled: true }); // enabled + trusted tier ⇒ ALLOW
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "gw-allow", manager: mgr, verifier: passVerifier, gateWall: gw });
    const s = new ChatSession("gw-allow", { workspace: ws, invoke: writeThenStop("landed.ts", "ship it\n") });
    await s.send("add a file");

    const r = await s.apply("repl: land it");
    assert.equal(r.applied, true, "an allowing gate still promotes");
    assert.equal(r.promote?.promoted, true);
    assert.ok(existsSync(join(repo, "landed.ts")), "the work landed in the target");
    // The decision trail exists and is an ALLOW.
    const decision = receipts.find((x) => x.operation === "gate.evaluate");
    assert.ok(decision !== undefined, "the gate produced a decision receipt");
    assert.equal(decision?.metadata?.allow, true, "the recorded decision is an ALLOW");
  } finally {
    await cleanup(repo, root);
  }
});

test("/apply: the promote NEVER happens without first asking the gate (decision trail is mandatory)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  // A gate spy that throws if NOT consulted exactly once before any land would be ideal; here we
  // assert the positive: the gate is consulted, and on deny nothing lands (covered above). This test
  // pins that even a verified-GREEN apply is gated — verification PASS is not sufficient to promote.
  const evaluated: string[] = [];
  const gw = {
    evaluate: async (input: { action: { kind: string } }) => {
      evaluated.push(input.action.kind);
      return { allow: false, reason: "spy gate denies", gateId: "spy" };
    },
  };
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "gw-mand", manager: mgr, verifier: passVerifier, gateWall: gw });
    const s = new ChatSession("gw-mand", { workspace: ws, invoke: writeThenStop("x.ts", "x\n") });
    await s.send("add a file");
    const r = await s.apply("repl: land");
    assert.deepEqual(evaluated, ["promote"], "the gate was consulted for a promote decision exactly once");
    assert.equal(r.applied, false, "no gate approval ⇒ no land, even on a GREEN verification");
    assert.ok(!existsSync(join(repo, "x.ts")), "nothing landed");
  } finally {
    await cleanup(repo, root);
  }
});
