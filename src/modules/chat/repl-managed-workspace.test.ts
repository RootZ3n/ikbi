/**
 * PHASE 2 — REPL repo-mode sessions edit a MANAGED workspace, not the target repo directly.
 *
 * These drive the REAL frozen-core workspace manager (a fresh one rooted in a temp dir, exactly as
 * the workspace unit tests do) through the session's managed lifecycle, proving the product
 * guarantees end-to-end: allocation, edit-isolation, /diff, explicit /apply, safe /discard,
 * /rollback-across-resume, and that scratch mode stays non-promotable.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
import { allocateSessionWorkspace, reconnectSessionWorkspace } from "./repl-workspace.js";
import { ChatSession } from "./session.js";

const silent = pino({ level: "silent" });

/** A deterministic PASS verifier (no real pnpm/tsc) — proves the apply gate without a toolchain. */
const passVerifier: RoleFn = async () => ({
  role: "verifier", outcome: "success", summary: 'verification PASSED for scope "impact"',
  detail: { verdict: "pass", verificationMode: "ladder", verificationScope: "impact", checks: [{ name: "tsc", exitCode: 0 }, { name: "test", exitCode: 0 }], stagesRun: ["package-checks"], receipts: ["GREEN for scope: impact"] },
});

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

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-mws-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}
function makeManager(): { mgr: WorkspaceManager; root: string } {
  const root = join(tmpdir(), `ikbi-mws-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  return { mgr: new WorkspaceManager({ root, max: 32, locks, store, logger: silent }), root };
}
async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
}

test("repo mode allocates a managed workspace, and a file edit affects the workspace — NOT the target repo", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "mw-1", manager: mgr });
    const s = new ChatSession("mw-1", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "feature.ts", content: "export const x = 1;\n" })), stop("done")]) });

    // The session is managed: isolated worktree, target recorded, worktree != target.
    assert.equal(s.workdirKind, "managed");
    assert.equal(s.isManaged(), true);
    assert.equal(s.targetRepo, repo);
    assert.notEqual(s.worktree, repo, "edits happen in an isolated worktree, not the target repo");

    await s.send("add a feature file");

    // The edit landed in the WORKSPACE…
    assert.ok(existsSync(join(s.worktree, "feature.ts")), "the new file exists in the managed worktree");
    // …and the TARGET REPO is untouched (no hidden live-direct editing).
    assert.ok(!existsSync(join(repo, "feature.ts")), "the target repo did NOT receive the edit");
  } finally {
    await cleanup(repo, root);
  }
});

test("/diff shows the workspace's pending changes against the base", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "mw-2", manager: mgr });
    const s = new ChatSession("mw-2", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "added.ts", content: "hello\n" })), stop("done")]) });
    await s.send("add a file");
    const diff = await s.getDiff();
    assert.match(diff, /added\.ts/, "the diff names the changed file");
    assert.match(diff, /\+hello/, "the diff shows the added content");
  } finally {
    await cleanup(repo, root);
  }
});

test("/apply updates the target repo ONLY after the explicit command", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "mw-3", manager: mgr, verifier: passVerifier });
    const s = new ChatSession("mw-3", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "landed.ts", content: "ship it\n" })), stop("done")]) });
    await s.send("add a file");

    // Before /apply: the target repo has NOT changed.
    assert.ok(!existsSync(join(repo, "landed.ts")), "no change to the target before /apply");

    const r = await s.apply("repl: land the feature");
    assert.equal(r.applied, true, "the explicit /apply promoted the work");
    assert.equal(r.promote?.promoted, true);
    assert.equal(r.verification?.ok, true, "verification ran and passed before promote");

    // After /apply: the file is in the target repo's working tree.
    assert.ok(existsSync(join(repo, "landed.ts")), "the target repo received the change after /apply");
    assert.equal(readFileSync(join(repo, "landed.ts"), "utf8"), "ship it\n");
  } finally {
    await cleanup(repo, root);
  }
});

test("/discard removes the workspace and leaves the target repo unchanged", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "mw-4", manager: mgr });
    const worktreePath = ws.path;
    const s = new ChatSession("mw-4", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "throwaway.ts", content: "nope\n" })), stop("done")]) });
    await s.send("add a file");
    assert.ok(existsSync(join(worktreePath, "throwaway.ts")));

    const r = await s.discardWorkspace();
    assert.equal(r.mode, "managed");
    assert.equal(r.removed, true);
    assert.ok(!existsSync(worktreePath), "the managed worktree was torn down");
    assert.ok(!existsSync(join(repo, "throwaway.ts")), "the target repo never received the discarded work");
  } finally {
    await cleanup(repo, root);
  }
});

test("/rollback works against the managed workspace and survives a resume", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "mw-5", manager: mgr });
    const s = new ChatSession("mw-5", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "edited.ts", content: "v1\n" })), stop("done")]) });
    await s.send("create edited.ts");
    assert.equal(readFileSync(join(s.worktree, "edited.ts"), "utf8"), "v1\n");

    // Persist + RESUME: reconnect to the same managed workspace, with the file history restored.
    const persisted = s.toPersisted();
    assert.equal(persisted.workspaceId, ws.id, "the workspace id is persisted for reconnect");
    assert.equal(persisted.workdirKind, "managed");

    const ws2 = await reconnectSessionWorkspace(ws.id, { manager: mgr });
    assert.ok(ws2 !== undefined, "the workspace reconnects after resume");
    const resumed = new ChatSession("mw-5", { restore: persisted, workspace: ws2 });
    assert.equal(resumed.worktree, s.worktree, "the resumed session points at the same managed worktree");

    // The rollback (restored from persisted fileHistory) reverts the edit IN THE WORKSPACE.
    const reverted = resumed.rollback(1);
    assert.equal(reverted.length, 1, "the persisted file history drove a rollback after resume");
    assert.ok(!existsSync(join(resumed.worktree, "edited.ts")), "the newly-created file was removed by the post-resume rollback");
  } finally {
    await cleanup(repo, root);
  }
});

test("scratch mode remains scratch and NON-PROMOTABLE", async () => {
  const s = new ChatSession("scratch-1", { scratch: true, invoke: queued([stop("ok")]) });
  assert.equal(s.workdirKind, "scratch");
  assert.equal(s.isManaged(), false);
  assert.equal(s.targetRepo, undefined, "scratch has no target repo to promote into");
  const r = await s.apply();
  assert.equal(r.applied, false);
  assert.match(r.summary, /NON-PROMOTABLE/i, "scratch /apply clearly says it is not promotable");
});
