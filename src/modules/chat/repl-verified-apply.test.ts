/**
 * PHASE 3 — REPL `/apply` runs the SAME ladder verification `ikbi build` uses, and promotes ONLY
 * on a pass. A failed, blocked, or undeterminable verification fails closed (no commit, no promote).
 *
 * The verifier is injected (a deterministic double) so these prove the GATE behavior without a real
 * toolchain; one test drives the REAL verifier wiring to prove it fails closed with no operator ctx.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { LockManager } from "../../core/substrate/lock.js";
import { DocumentStore } from "../../core/substrate/store.js";
import type { WorkspaceRecord } from "../../core/workspace/contract.js";
import { runGit } from "../../core/workspace/git.js";
import { WorkspaceManager } from "../../core/workspace/manager.js";
import { pino } from "pino";

import type { RoleFn } from "../worker-model/contract.js";
import { runRepl } from "./cli.js";
import { allocateSessionWorkspace, reconnectSessionWorkspace } from "./repl-workspace.js";
import { ChatSession } from "./session.js";
import { PersistentSessionStore } from "./session-store.js";

const silent = pino({ level: "silent" });

type Invoke = ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    cost: { usd: 0.001, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 1, completionPerMTok: 1 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `c-${name}`, name, arguments: JSON.stringify(args) });
const toolTurn = (...calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
function queued(responses: ModelResponse[]): Invoke {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)] ?? stop("")) as unknown as Invoke;
}
function lines(arr: string[]): () => Promise<string | null> {
  let i = 0;
  return () => Promise.resolve(i < arr.length ? (arr[i++] as string) : null);
}
const store = (): PersistentSessionStore => new PersistentSessionStore(mkdtempSync(join(tmpdir(), "ikbi-va-store-")));

// ── deterministic verifier doubles ───────────────────────────────────────────
const passVerifier: RoleFn = async () => ({
  role: "verifier", outcome: "success", summary: 'verification PASSED for scope "impact"',
  detail: { verdict: "pass", verificationMode: "ladder", verificationScope: "impact", checks: [{ name: "tsc", exitCode: 0 }, { name: "test", exitCode: 0 }], stagesRun: ["package-checks"], receipts: ["GREEN for scope: impact"] },
});
const failVerifier: RoleFn = async () => ({
  role: "verifier", outcome: "failure", summary: "verification FAILED (scope impact) at package-checks/tsc",
  detail: { verdict: "fail", verificationMode: "ladder", verificationScope: "impact", checks: [{ name: "tsc", exitCode: 1 }], triage: [{ stage: "package-checks", name: "tsc", passed: false, errorSummary: "TS2345 not assignable" }], failedAt: { stage: "package-checks", task: "tsc" }, stagesRun: ["package-checks"], receipts: ["FAILED at package-checks/tsc"] },
});
const blockedVerifier: RoleFn = async () => ({
  role: "verifier", outcome: "failure", summary: "verification BLOCKED (scope full)",
  detail: { verdict: "fail", verificationScope: "full", blocked: true, blockReasons: ["could not determine changed files"], checks: [], stagesRun: [], receipts: [] },
});

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-va-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}
function makeManager(): { mgr: WorkspaceManager; root: string } {
  const root = join(tmpdir(), `ikbi-va-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const docs = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  return { mgr: new WorkspaceManager({ root, max: 32, locks, store: docs, logger: silent }), root };
}
async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
}
/** Allocate a managed session editing one file, with the given verifier double. */
async function managedSession(repo: string, mgr: WorkspaceManager, id: string, verifier: RoleFn, file = "feature.ts"): Promise<ChatSession> {
  const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: id, manager: mgr, verifier });
  const s = new ChatSession(id, { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: file, content: "export const x = 1;\n" })), stop("done")]) });
  await s.send("add a feature file");
  return s;
}

test("managed /apply runs the verifier and promotes ONLY on a pass", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    let verifierCalled = false;
    const trackedPass: RoleFn = async (ctx) => { verifierCalled = true; return passVerifier(ctx); };
    const s = await managedSession(repo, mgr, "va-pass", trackedPass);
    assert.ok(!existsSync(join(repo, "feature.ts")), "target unchanged before /apply");

    const r = await s.apply();
    assert.equal(verifierCalled, true, "/apply ran verification before promoting");
    assert.equal(r.verification?.ok, true);
    assert.equal(r.applied, true);
    assert.ok(existsSync(join(repo, "feature.ts")), "promoted to the target only after a passing verification");
  } finally {
    await cleanup(repo, root);
  }
});

test("verification FAILURE blocks the promote — the target repo is untouched", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const s = await managedSession(repo, mgr, "va-fail", failVerifier);
    const r = await s.apply();
    assert.equal(r.applied, false, "a failed verification does not promote");
    assert.equal(r.verification?.ok, false);
    assert.equal(r.promote, undefined, "no promote was attempted");
    assert.match(r.summary, /NOT applied/);
    assert.match(r.summary, /FAILED/);
    assert.ok(!existsSync(join(repo, "feature.ts")), "the target repo never received the unverified change");
  } finally {
    await cleanup(repo, root);
  }
});

test("verification BLOCKED blocks the promote (fail closed)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const s = await managedSession(repo, mgr, "va-blocked", blockedVerifier);
    const r = await s.apply();
    assert.equal(r.applied, false);
    assert.equal(r.verification?.blocked, true);
    assert.match(r.summary, /BLOCKED/);
    assert.ok(!existsSync(join(repo, "feature.ts")), "a blocked verification never promotes");
  } finally {
    await cleanup(repo, root);
  }
});

test("/apply output includes verification mode, scope, and the checks that ran", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "va-out", manager: mgr, verifier: passVerifier });
    const s = new ChatSession("va-out", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "out.ts", content: "y\n" })), stop("done")]) });
    let out = "";
    await runRepl({ session: s, store: store(), readLine: lines(["edit a file", "/apply", "/exit"]), out: (o) => { out += o; } });
    assert.match(out, /verification: PASS — mode=ladder, scope=impact/);
    assert.match(out, /checks: tsc ✓, test ✓/);
    assert.match(out, /verified \(ladder, scope impact\) and applied/);
  } finally {
    await cleanup(repo, root);
  }
});

test("/apply output shows the failure/triage summary when verification fails", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "va-out-fail", manager: mgr, verifier: failVerifier });
    const s = new ChatSession("va-out-fail", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "bad.ts", content: "z\n" })), stop("done")]) });
    let out = "";
    await runRepl({ session: s, store: store(), readLine: lines(["edit a file", "/apply", "/exit"]), out: (o) => { out += o; } });
    assert.match(out, /verification: FAIL — mode=ladder, scope=impact/);
    assert.match(out, /checks: tsc ✗/);
    assert.match(out, /failure: package-checks\/tsc: TS2345 not assignable/);
  } finally {
    await cleanup(repo, root);
  }
});

test("scratch and live-direct sessions cannot apply (no verification/promote)", async () => {
  const scratch = new ChatSession("va-scratch", { scratch: true, invoke: queued([stop("ok")]) });
  const sr = await scratch.apply();
  assert.equal(sr.applied, false);
  assert.match(sr.summary, /NON-PROMOTABLE/i);
  assert.equal(sr.verification, undefined, "scratch never runs verification");

  const dir = mkdtempSync(join(tmpdir(), "ikbi-va-live-"));
  const live = new ChatSession("va-live", { worktree: dir, invoke: queued([stop("ok")]) });
  assert.equal(live.workdirKind, "explicit");
  const lr = await live.apply();
  assert.equal(lr.applied, false);
  assert.match(lr.summary, /UNAVAILABLE/i);
});

test("a resumed managed session applies WITH verification", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const s = await managedSession(repo, mgr, "va-resume", passVerifier);
    const persisted = s.toPersisted();

    const ws2 = await reconnectSessionWorkspace(persisted.workspaceId!, { manager: mgr, sessionId: persisted.id, verifier: passVerifier });
    assert.ok(ws2 !== undefined);
    const resumed = new ChatSession("va-resume", { restore: persisted, workspace: ws2 });
    const r = await resumed.apply();
    assert.equal(r.verification?.ok, true, "the resumed session re-ran verification");
    assert.equal(r.applied, true);
    assert.ok(existsSync(join(repo, "feature.ts")), "the resumed session promoted after verification");
  } finally {
    await cleanup(repo, root);
  }
});

test("the apply verification result is recorded in the session transcript/memory (req 8)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const s = await managedSession(repo, mgr, "va-receipt", passVerifier);
    await s.apply();
    const memText = s.memory.summary();
    assert.match(memText, /\/apply verification: PASS/);
    assert.match(memText, /mode=ladder/);
    assert.match(memText, /promoted/);
  } finally {
    await cleanup(repo, root);
  }
});

test("fail closed: a managed session with NO operator context does not promote (real verifier wiring)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    // No injected verifier ⇒ the REAL createVerifier wiring runs. The chat session has no parentCtx
    // here (no operator/worker token in the test env), so governed checks can't be authorized.
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "va-noctx", manager: mgr });
    const s = new ChatSession("va-noctx", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "nc.ts", content: "n\n" })), stop("done")]) });
    await s.send("edit");
    const r = await s.apply();
    assert.equal(r.applied, false, "without a verification context, /apply fails closed");
    assert.equal(r.verification?.outcome, "unavailable");
    assert.ok(!existsSync(join(repo, "nc.ts")), "the target repo is untouched when verification can't run");
  } finally {
    await cleanup(repo, root);
  }
});
