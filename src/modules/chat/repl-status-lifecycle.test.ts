/**
 * PHASE 2 — `/status` reports the managed-workspace lifecycle truth through the live REPL adapter.
 *
 * Requirement 7: /status must show the target repo, workspace path, base ref, pending changes, and
 * the lifecycle mode. For a managed session it must read managed-workspace true / promotable; for a
 * scratch session it must clearly read NON-PROMOTABLE.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
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

import { runRepl } from "./cli.js";
import { allocateSessionWorkspace } from "./repl-workspace.js";
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
const store = (): PersistentSessionStore => new PersistentSessionStore(mkdtempSync(join(tmpdir(), "ikbi-st-store-")));

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-st-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}
function makeManager(): { mgr: WorkspaceManager; root: string } {
  const root = join(tmpdir(), `ikbi-st-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const docs = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  return { mgr: new WorkspaceManager({ root, max: 32, locks, store: docs, logger: silent }), root };
}
async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
}

test("/status reports managed-workspace true, with target repo / workspace / base ref / pending changes", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await allocateSessionWorkspace({ targetRepo: repo, sessionId: "st-1", manager: mgr });
    const s = new ChatSession("st-1", { workspace: ws, invoke: queued([toolTurn(call("write_file", { path: "p.ts", content: "pending\n" })), stop("done")]) });
    let out = "";
    await runRepl({ session: s, store: store(), readLine: lines(["add a file", "/status", "/exit"]), out: (o) => { out += o; } });

    assert.match(out, /lifecycle:\s+managed-workspace \(promotable via \/apply\)/, "managed mode is reported as promotable");
    assert.match(out, new RegExp(`target repo:\\s+${repo.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}`), "the target repo is shown");
    assert.match(out, new RegExp(`workspace:\\s+${ws.path.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}`), "the isolated workspace path is shown");
    assert.match(out, /base ref:\s+[0-9a-f]{12} \(main\)/, "the base ref + branch are shown");
    assert.match(out, /pending:\s+[1-9][0-9]* file\(s\) changed/, "pending changes are counted");
    // Phase 3: managed mode discloses /apply runs ladder verification before promoting.
    assert.match(out, /runs ladder verification/);
  } finally {
    await cleanup(repo, root);
  }
});

test("/status for a scratch session reads NON-PROMOTABLE", async () => {
  const s = new ChatSession("st-scratch", { scratch: true, invoke: queued([stop("ok")]) });
  let out = "";
  await runRepl({ session: s, store: store(), readLine: lines(["/status", "/exit"]), out: (o) => { out += o; } });
  assert.match(out, /lifecycle:\s+scratch \(NON-PROMOTABLE/);
  assert.match(out, /target repo:\s+\(none/);
});
