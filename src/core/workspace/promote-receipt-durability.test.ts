/**
 * Codex blocker 1 — promotion receipt / undo DURABILITY.
 *
 * A promote must never modify the real repo without a recoverable audit trail:
 *   - if the PRE-promote durable intent write fails, the target ref must NOT move;
 *   - if the POST-promote receipt append fails AFTER the CAS, the landing must be surfaced as
 *     PROMOTED_BUT_RECEIPT_FAILED (not a clean success) AND a durable recoverable record must exist;
 *   - `ikbi undo` must recover from that durable record even with the normal receipt missing.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pino, type Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import type { ReceiptInput } from "../receipt/contract.js";
import { LockManager } from "../substrate/lock.js";
import { DocumentStore } from "../substrate/store.js";
import { type WorkspaceRecord } from "./contract.js";
import { revParse, runGit } from "./git.js";
import { WorkspaceManager } from "./manager.js";
import { createUndoCli } from "../../cli/undo.js";

const silent: Logger = pino({ level: "silent" });
const ID: AgentIdentity = { agentId: "builder-3", functionalRole: "builder", trustTier: "verified" };
const APPROVE = { evaluation: { approved: true }, governance: { allow: true } } as const;

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-prd-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
}

/** A store wrapper that lets a test FAIL a `put` matching a predicate (e.g. the promoting intent). */
class FailingStore extends DocumentStore<WorkspaceRecord> {
  failPutWhen?: (value: WorkspaceRecord) => boolean;
  override async put(id: string, value: WorkspaceRecord): Promise<void> {
    if (this.failPutWhen?.(value)) throw new Error("simulated registry write failure");
    return super.put(id, value);
  }
}

function makeManager(opts?: { receipts?: { append(i: ReceiptInput, id: AgentIdentity): Promise<unknown> }; store?: DocumentStore<WorkspaceRecord> }) {
  const root = join(tmpdir(), `ikbi-prd-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = opts?.store ?? new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  const mgr = new WorkspaceManager({ root, max: 32, locks, store, logger: silent, ...(opts?.receipts ? { receipts: opts.receipts } : {}) });
  return { mgr, root, store, locks };
}
async function cleanup(repo: string, root: string): Promise<void> {
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
async function makeChange(mgr: WorkspaceManager, repo: string): Promise<{ ws: Awaited<ReturnType<WorkspaceManager["allocate"]>> }> {
  const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
  await writeFile(join(ws.path, "feature.txt"), "work\n");
  await mgr.commit(ws, "add feature");
  return { ws };
}

test("pre-promote durable intent fails ⇒ the target ref does NOT move", async () => {
  const repo = await makeRepo();
  const root = join(tmpdir(), `ikbi-prd-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new FailingStore({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  const mgr = new WorkspaceManager({ root, max: 32, locks, store, logger: silent });
  try {
    const { ws } = await makeChange(mgr, repo);
    const before = await revParse(repo, "main");
    // Fail the PROMOTING intent write specifically (the record written BEFORE the CAS).
    store.failPutWhen = (v) => v.state === "promoting";
    await assert.rejects(mgr.promote(ws, APPROVE), /simulated registry write failure/);
    const after = await revParse(repo, "main");
    assert.equal(after, before, "the target branch must NOT move when the pre-promote intent failed");
  } finally {
    await cleanup(repo, root);
  }
});

test("post-promote receipt failure ⇒ PROMOTED_BUT_RECEIPT_FAILED + a durable recoverable record", async () => {
  const repo = await makeRepo();
  const failingReceipts = { append: async (): Promise<unknown> => { throw new Error("receipt store down"); } };
  const { mgr, root } = makeManager({ receipts: failingReceipts });
  try {
    const { ws } = await makeChange(mgr, repo);
    const before = await revParse(repo, "main");
    const r = await mgr.promote(ws, APPROVE);

    // The promote LANDED (CAS moved the branch) but is NOT a clean success.
    assert.equal(r.promoted, true, "the CAS landed");
    assert.equal(r.receiptStatus, "failed", "surfaced as PROMOTED_BUT_RECEIPT_FAILED, not clean success");
    const after = await revParse(repo, "main");
    assert.notEqual(after, before, "the branch moved");
    assert.equal(after, r.afterRef);

    // A durable, recoverable promote record exists with the before/after refs.
    const rec = await mgr.get(ws.id);
    assert.equal(rec?.state, "promoted");
    assert.equal(rec?.receiptStatus, "failed");
    assert.equal(rec?.promoteIntent?.beforeRef, before, "the durable record carries the pre-promote ref");
    assert.equal(rec?.promotedTo, after);
    assert.match(rec?.note ?? "", /PROMOTED_BUT_RECEIPT_FAILED/);
  } finally {
    await cleanup(repo, root);
  }
});

test("ikbi undo recovers from the durable promote record when the receipt is missing", async () => {
  const repo = await makeRepo();
  const failingReceipts = { append: async (): Promise<unknown> => { throw new Error("receipt store down"); } };
  const { mgr, root } = makeManager({ receipts: failingReceipts });
  try {
    const { ws } = await makeChange(mgr, repo);
    const before = await revParse(repo, "main");
    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.receiptStatus, "failed");
    const landed = await revParse(repo, "main");
    assert.notEqual(landed, before);

    // undo with an EMPTY receipt log (the promote receipt never landed) — must fall back to the
    // durable workspace registry record and restore the previous ref.
    const appended: ReceiptInput[] = [];
    let exit = 0;
    const out: string[] = [];
    const undo = createUndoCli({
      receipts: { query: async () => [], append: async (i) => { appended.push(i); return { id: "undo-1" } as never; } },
      workspaces: { list: () => mgr.list() },
      resolveIdentity: () => ({ identity: ID }) as never,
      operatorToken: "operator-token",
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      setExit: (c) => { exit = c; },
    });
    await undo.undo([landed]); // by promoted commit sha

    assert.equal(exit, 0, `undo succeeded; output: ${out.join("")}`);
    const restored = await revParse(repo, "main");
    assert.equal(restored, before, "undo restored the pre-promote ref from the durable record");
    assert.ok(out.join("").includes("PROMOTED_BUT_RECEIPT_FAILED") || out.join("").includes("durable promote record"), "undo discloses the registry-recovery path");
    assert.equal(appended.length, 1, "the undo itself was receipted");
  } finally {
    await cleanup(repo, root);
  }
});

test("a healthy promote records receiptStatus=recorded (no false PROMOTED_BUT_RECEIPT_FAILED)", async () => {
  const repo = await makeRepo();
  const okReceipts = { append: async (): Promise<unknown> => ({ id: "ok" }) };
  const { mgr, root } = makeManager({ receipts: okReceipts });
  try {
    const { ws } = await makeChange(mgr, repo);
    const r = await mgr.promote(ws, APPROVE);
    assert.equal(r.promoted, true);
    assert.equal(r.receiptStatus, "recorded");
    const rec = await mgr.get(ws.id);
    assert.equal(rec?.receiptStatus, "recorded");
    assert.ok((rec?.note ?? "").indexOf("PROMOTED_BUT_RECEIPT_FAILED") === -1);
  } finally {
    await cleanup(repo, root);
  }
});
