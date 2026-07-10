/**
 * C1c — HASH-BOUND promotion authorization. `promote` binds to the exact state the caller verified:
 * a target that moved, or a landed tree that differs from the certified tree, REFUSES (re-verify) and
 * never moves the target ref. Absent authorization ⇒ legacy CAS-only behavior (unchanged).
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import { LockManager } from "../substrate/lock.js";
import { DocumentStore } from "../substrate/store.js";
import type { WorkspaceRecord } from "./contract.js";
import { revParse, runGit } from "./git.js";
import { WorkspaceManager } from "./manager.js";

const silent: Logger = pino({ level: "silent" });
const ID: AgentIdentity = { agentId: "builder-3", functionalRole: "builder", trustTier: "verified" };
const GOVERN = { allow: true } as const;

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-hashbound-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "test@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
}

function makeManager() {
  const root = join(tmpdir(), `ikbi-hashbound-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({ dir: join(root, "registry"), locks, logger: silent, fsync: false });
  const mgr = new WorkspaceManager({ root, max: 32, locks, store, logger: silent });
  return { mgr, root };
}

async function cleanup(repo: string, root: string): Promise<void> {
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

test("C1c: matching authorization (head + tree) ⇒ promote lands", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    await mgr.commit(ws, "add feature");

    const targetHead = await revParse(repo, "main");
    const integratedTree = await revParse(repo, `${ws.scratchBranch}^{tree}`);

    const r = await mgr.promote(ws, { evaluation: { approved: true }, governance: GOVERN, verifiedAgainst: { targetHead, integratedTree } });
    assert.equal(r.promoted, true, "certified state lands");
    assert.equal(r.strategy, "fast_forward");
    assert.equal(await revParse(repo, `${r.afterRef}^{tree}`), integratedTree, "landed tree is the certified tree");
  } finally {
    await cleanup(repo, root);
  }
});

test("C1c: target moved since verification ⇒ REFUSE, target ref untouched", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    await mgr.commit(ws, "add feature");

    const staleHead = await revParse(repo, "main"); // what the caller verified against
    const integratedTree = await revParse(repo, `${ws.scratchBranch}^{tree}`);

    // The target advances AFTER verification (a concurrent promote / operator commit).
    await writeFile(join(repo, "main-change.txt"), "main moved\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "main moved"]);
    const liveHead = await revParse(repo, "main");

    const r = await mgr.promote(ws, { evaluation: { approved: true }, governance: GOVERN, verifiedAgainst: { targetHead: staleHead, integratedTree } });
    assert.equal(r.promoted, false, "refused — the verifier never saw this target");
    assert.match(r.reason ?? "", /target moved since verification/);
    assert.equal(await revParse(repo, "main"), liveHead, "the target ref was NOT moved");
  } finally {
    await cleanup(repo, root);
  }
});

test("C1c: landed tree ≠ certified tree ⇒ REFUSE (post-verify write / unseen merge tree)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    await mgr.commit(ws, "add feature");

    const targetHead = await revParse(repo, "main");
    const wrongTree = "0000000000000000000000000000000000000000"; // not the scratch tree

    const before = await revParse(repo, "main");
    const r = await mgr.promote(ws, { evaluation: { approved: true }, governance: GOVERN, verifiedAgainst: { targetHead, integratedTree: wrongTree } });
    assert.equal(r.promoted, false, "refused — the promoted tree is not the certified tree");
    assert.match(r.reason ?? "", /≠ certified tree/);
    assert.equal(await revParse(repo, "main"), before, "the target ref was NOT moved");
  } finally {
    await cleanup(repo, root);
  }
});

test("C1c: absent authorization ⇒ legacy CAS-only promote still lands (no regression)", async () => {
  const repo = await makeRepo();
  const { mgr, root } = makeManager();
  try {
    const ws = await mgr.allocate({ targetRepo: repo, identity: ID });
    await writeFile(join(ws.path, "feature.txt"), "feature\n");
    await mgr.commit(ws, "add feature");

    const r = await mgr.promote(ws, { evaluation: { approved: true }, governance: GOVERN });
    assert.equal(r.promoted, true, "no verifiedAgainst ⇒ unchanged behavior");
  } finally {
    await cleanup(repo, root);
  }
});
