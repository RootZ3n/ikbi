/**
 * SG-3 (audit): `ikbi undo` reverts a promoted change — the branch ref AND the working tree
 * go back to the pre-promote state, in one command, and the undo is recorded as a receipt.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { ValidatedIdentity } from "../core/identity/index.js";
import type { Receipt, ReceiptInput, ReceiptQuery } from "../core/receipt/index.js";
import { runGit } from "../core/workspace/git.js";
import { createUndoCli, type UndoGit } from "./undo.js";

const ID: AgentIdentity = { agentId: "operator", trustTier: "operator" };
const VALIDATED = { identity: ID } as ValidatedIdentity;

/** An in-memory receipt store (controls what undo reads; captures what it appends). */
function memReceipts(initial: Receipt[]) {
  const list = [...initial];
  const appended: ReceiptInput[] = [];
  return {
    appended,
    store: {
      query: async (_f?: ReceiptQuery): Promise<Receipt[]> => [...list],
      append: async (input: ReceiptInput): Promise<Receipt> => {
        appended.push(input);
        const r = { contractVersion: "1.0.0", id: `u${appended.length}`, seq: list.length, timestamp: 0, identity: ID, changes: [], ...input } as Receipt;
        list.push(r);
        return r;
      },
    },
  };
}

function promoteReceipt(repo: string, branch: string, beforeRef: string, afterRef: string): Receipt {
  return {
    contractVersion: "1.0.0", id: "promo-1", seq: 0, timestamp: 0, identity: ID, operation: "workspace.promote",
    outcome: { status: "success", detail: "fast_forward" },
    changes: [{ kind: "state", target: `${repo}#${branch}`, before: { ref: beforeRef }, after: { ref: afterRef }, inverse: { operation: "git.update-ref", args: { ref: `refs/heads/${branch}`, to: beforeRef } } }],
    requestId: "build-1",
  } as Receipt;
}

function capture() {
  let out = ""; let err = ""; let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

// ── integration: real git, restores ref + working tree ────────────────────────

test("undo reverts a promotion: branch ref AND working tree return to the prior state", async () => {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-undo-repo-"));
  try {
    await runGit(repo, ["init", "-b", "main", "--quiet"]);
    await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
    await runGit(repo, ["config", "user.name", "ikbi test"]);
    await writeFile(join(repo, "README.md"), "base\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "base"]);
    const beforeRef = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();
    // The "promoted" change: a new file committed onto main.
    await writeFile(join(repo, "feature.txt"), "the feature\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "feature"]);
    const afterRef = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();
    assert.notEqual(beforeRef, afterRef);

    const mem = memReceipts([promoteReceipt(repo, "main", beforeRef, afterRef)]);
    const cap = capture();
    await createUndoCli({ receipts: mem.store, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).undo(["promo-1"]);

    assert.equal(cap.exit, undefined, "undo succeeded");
    assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout.trim(), beforeRef, "branch ref reset to before");
    assert.equal((await runGit(repo, ["status", "--porcelain"])).stdout.trim(), "", "working tree clean (synced to before)");
    await assert.rejects(access(join(repo, "feature.txt")), "the promoted file is gone from the working tree");
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "base\n", "the prior content is restored");
    // The undo was recorded (corrects the original).
    assert.equal(mem.appended.length, 1);
    assert.equal(mem.appended[0]?.operation, "workspace.undo");
    assert.equal(mem.appended[0]?.corrects, "promo-1");
    assert.match(cap.out, /undone: "main" reset/);
  } finally {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ── refuse cases (fake git) ───────────────────────────────────────────────────

function fakeGit(over: Partial<UndoGit> = {}): { git: UndoGit; cas: Array<{ ref: string; newSha: string; oldSha: string }>; synced: string[] } {
  const cas: Array<{ ref: string; newSha: string; oldSha: string }> = [];
  const synced: string[] = [];
  const git: UndoGit = {
    revParse: async () => "AFTER",
    worktreeForBranch: async () => "/wt/main",
    isWorktreeClean: async () => true,
    updateRefCas: async (_r, ref, newSha, oldSha) => { cas.push({ ref, newSha, oldSha }); },
    syncWorktreeToRef: async (p) => { synced.push(p); },
    ...over,
  };
  return { git, cas, synced };
}
const REC = (): Receipt[] => [promoteReceipt("/repo", "main", "BEFORE", "AFTER")];

test("undo CAS-resets after→before and syncs the worktree (with fakes)", async () => {
  const mem = memReceipts(REC());
  const g = fakeGit();
  const cap = capture();
  await createUndoCli({ receipts: mem.store, git: g.git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).undo(["promo-1"]);
  assert.deepEqual(g.cas, [{ ref: "refs/heads/main", newSha: "BEFORE", oldSha: "AFTER" }], "atomic after→before reset");
  assert.deepEqual(g.synced, ["/wt/main"], "the checked-out tree was synced");
  assert.equal(cap.exit, undefined);
});

test("undo refuses when the branch has moved on (no clobber)", async () => {
  const mem = memReceipts(REC());
  const g = fakeGit({ revParse: async () => "MOVED" });
  const cap = capture();
  await createUndoCli({ receipts: mem.store, git: g.git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).undo(["promo-1"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /moved on|not the promoted/);
  assert.equal(g.cas.length, 0, "the ref was NOT reset");
  assert.equal(mem.appended.length, 0, "no undo recorded");
});

test("undo refuses a dirty checked-out tree, and errors on an unknown id", async () => {
  const dirty = memReceipts(REC());
  const g = fakeGit({ isWorktreeClean: async () => false });
  const c1 = capture();
  await createUndoCli({ receipts: dirty.store, git: g.git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: c1.stdout, stderr: c1.stderr, setExit: c1.setExit }).undo(["promo-1"]);
  assert.equal(c1.exit, 1);
  assert.match(c1.err, /uncommitted changes/);
  assert.equal(g.cas.length, 0);

  const c2 = capture();
  await createUndoCli({ receipts: memReceipts(REC()).store, git: fakeGit().git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: c2.stdout, stderr: c2.stderr, setExit: c2.setExit }).undo(["does-not-exist"]);
  assert.equal(c2.exit, 1);
  assert.match(c2.err, /no revertible promote/);
});

test("undo requires a resolved operator identity before reading or reverting", async () => {
  let queried = false;
  const cap = capture();
  await createUndoCli({
    receipts: { query: async () => { queried = true; return REC(); }, append: async () => { throw new Error("not reached"); } },
    git: fakeGit().git,
    operatorToken: undefined,
    stdout: cap.stdout,
    stderr: cap.stderr,
    setExit: cap.setExit,
  }).undo(["promo-1"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no operator identity/);
  assert.equal(queried, false, "undo does not touch receipts before auth");

  const denied = capture();
  await createUndoCli({
    receipts: { query: async () => { queried = true; return REC(); }, append: async () => { throw new Error("not reached"); } },
    git: fakeGit().git,
    operatorToken: "bad-token",
    resolveIdentity: () => { throw new Error("bad credentials"); },
    stdout: denied.stdout,
    stderr: denied.stderr,
    setExit: denied.setExit,
  }).undo(["promo-1"]);
  assert.equal(denied.exit, 1);
  assert.match(denied.err, /operator identity resolution failed: bad credentials/);
});

// ── --latest flag ─────────────────────────────────────────────────────────────

test("undo --latest undoes the most recent successful promotion", async () => {
  const mem = memReceipts(REC());
  const g = fakeGit();
  const cap = capture();
  await createUndoCli({ receipts: mem.store, git: g.git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).undo(["--latest"]);
  assert.equal(cap.exit, undefined, "--latest succeeded");
  assert.deepEqual(g.cas, [{ ref: "refs/heads/main", newSha: "BEFORE", oldSha: "AFTER" }], "the promoted commit was reset");
  assert.match(cap.out, /undone: "main" reset/, "success message is printed");
  assert.equal(mem.appended.length, 1);
  assert.equal(mem.appended[0]?.corrects, "promo-1");
});

test("undo --latest fails cleanly when there are no successful promotions", async () => {
  const mem = memReceipts([]); // empty receipt log
  const g = fakeGit();
  const cap = capture();
  await createUndoCli({ receipts: mem.store, git: g.git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).undo(["--latest"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no revertible promotion/);
  assert.equal(g.cas.length, 0, "no ref was reset");
});

test("undo --latest picks the most recent of multiple promotions", async () => {
  const base = promoteReceipt("/repo", "main", "BASE", "V1");
  const older: Receipt = { ...base, id: "old-promo", seq: 0 };
  const next: Receipt = { ...base, id: "new-promo", seq: 1, changes: [{ kind: "state", target: "/repo#main", before: { ref: "V1" }, after: { ref: "V2" }, inverse: { operation: "git.update-ref", args: { ref: "refs/heads/main", to: "V1" } } }] };
  const mem = memReceipts([older, next]);
  const g = fakeGit({ revParse: async () => "V2" }); // branch is at V2 (the newer promotion)
  const cap = capture();
  await createUndoCli({ receipts: mem.store, git: g.git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).undo(["--latest"]);
  assert.equal(cap.exit, undefined, "succeeded");
  assert.deepEqual(g.cas, [{ ref: "refs/heads/main", newSha: "V1", oldSha: "V2" }], "reverted V2 → V1, not BASE → V1");
  assert.equal(mem.appended[0]?.corrects, "new-promo", "corrects the newer receipt");
});

// ── preview output ────────────────────────────────────────────────────────────

test("undo shows a revert preview and safety confirmation before reverting", async () => {
  const mem = memReceipts(REC());
  const g = fakeGit();
  const cap = capture();
  await createUndoCli({ receipts: mem.store, git: g.git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).undo(["promo-1"]);
  assert.equal(cap.exit, undefined, "succeeded");
  assert.match(cap.out, /Revert preview/, "shows a preview header");
  assert.match(cap.out, /promoted commit/, "shows the promoted commit label");
  assert.match(cap.out, /Safe to revert/, "confirms the revert is safe");
});

test("undo preview shows the diff when gitDiff is provided", async () => {
  const mem = memReceipts(REC());
  const g = fakeGit({ gitDiff: async () => "diff --git a/x b/x\n+added line\n-removed line\n" });
  const cap = capture();
  await createUndoCli({ receipts: mem.store, git: g.git, operatorToken: "op-token", resolveIdentity: () => VALIDATED, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit }).undo(["promo-1"]);
  assert.equal(cap.exit, undefined, "succeeded");
  assert.match(cap.out, /Changes that will be undone/, "diff section header shown");
  assert.match(cap.out, /added line/, "diff content shown");
});
