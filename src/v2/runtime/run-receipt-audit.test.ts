/**
 * HOSTILE AUDIT of the operator receipt the v2 engine writes.
 *
 * `run-receipt.test.ts` proves the shapes. This proves the obligations an auditor would actually
 * press on: that a publication yields EXACTLY one reversible record and never two, that a run
 * which published nothing leaves nothing that looks undoable, that the record binds enough
 * identity to be checked rather than believed, and that a receipt which failed to write cannot be
 * mistaken for one that succeeded.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { recordBuildSessionReceipts } from "./run-receipt.js";
import type { ReceiptInput } from "../../core/receipt/contract.js";
import type { V2BuildSessionResult } from "../core/session.js";

const REPO = "/repos/alpha";

function sink(fail = false) {
  const appended: ReceiptInput[] = [];
  return { appended, append: async (i: ReceiptInput) => { if (fail) throw new Error("store unwritable"); appended.push(i); return undefined; } };
}

const PROMOTION = {
  promotionId: "prom_1", candidateId: "cand_1", candidateTreeId: "tree_1", targetBranch: "main",
  strategy: "clean_ref_cas", beforeRef: "base000", afterRef: "landed9", publishedTree: "tree_1",
  worktreeSynced: true, stashed: false, idempotent: false, degraded: false, postCasVerified: true,
};

function session(over: { promotion?: Record<string, unknown> | undefined; outcome?: string; attempts?: unknown[] } = {}): V2BuildSessionResult {
  const promotion = "promotion" in over ? over.promotion : PROMOTION;
  return {
    buildSessionId: "sess_1",
    outcome: { kind: over.outcome ?? "accepted" },
    recoveryDecisions: [{ kind: "stop_accepted" }],
    receipt: { totalAttempts: 1 },
    ledger: [],
    attempts: over.attempts ?? [{
      runId: "run_abc", taskId: "task_abc",
      journal: [{ from: "publication", to: "terminal" }],
      receipt: {
        candidate: { candidateId: "cand_1", workspaceId: "ws_1", treeId: "tree_1" },
        verification: { verdict: "pass", verificationId: "verif_deadbeef" },
        ...(promotion !== undefined ? { promotion } : {}),
      },
    }],
  } as unknown as V2BuildSessionResult;
}

const promote = (s: ReturnType<typeof sink>) => s.appended.filter((r) => r.operation === "workspace.promote");
const summary = (s: ReturnType<typeof sink>) => s.appended.filter((r) => r.operation === "run.summary");

test("audit: a publication produces EXACTLY ONE reversible record", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  // Two anchors for one ref move would give `undo --latest` a choice it must never have.
  assert.equal(promote(s).length, 1);
  assert.equal(summary(s).length, 1);
  assert.equal(s.appended.length, 2);
});

test("audit: recording the SAME session twice is the caller's error, not a second ref move", async () => {
  // The recorder is called once from one production call site. If that ever changed, the receipt
  // log would carry two anchors for one landing — so this pins what such a bug would look like.
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  await recordBuildSessionReceipts(session(), REPO, s);
  assert.equal(promote(s).length, 2, "two calls write two records — there is no dedupe here");
  // Both describe the identical ref move, which is how an auditor would spot the duplication.
  const [a, b] = promote(s);
  assert.deepEqual(a!.changes, b!.changes);
});

test("audit: a run that published NOTHING leaves nothing that looks undoable", async () => {
  for (const promotion of [undefined, { ...PROMOTION, beforeRef: "same", afterRef: "same" }, { ...PROMOTION, afterRef: "" }]) {
    const s = sink();
    await recordBuildSessionReceipts(session({ promotion, outcome: "failed" }), REPO, s);
    assert.equal(promote(s).length, 0, `promotion=${JSON.stringify(promotion)?.slice(0, 40)} must leave no undo anchor`);
    assert.equal(summary(s).length, 1, "the run is still recorded — silence is not honesty");
  }
});

test("audit: the record binds REPOSITORY, BASE commit, PROMOTED commit and VERIFICATION IDENTITY", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  const m = promote(s)[0]!.metadata!;
  assert.equal(m["repository"], REPO);
  assert.equal(m["baseCommit"], "base000");
  assert.equal(m["promotedCommit"], "landed9");
  assert.equal(m["publishedTree"], "tree_1");
  assert.equal(m["candidateTreeId"], "tree_1");
  // A VERDICT IS NOT AN IDENTITY. Two verifications both say "pass"; only the id says which one
  // authorized this commit.
  assert.equal(m["verificationId"], "verif_deadbeef");
  assert.equal(m["verificationVerdict"], "pass");
  assert.equal(m["promotionId"], "prom_1");
});

test("audit: the run summary carries the verification identity too", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  assert.equal(summary(s)[0]!.metadata!["verificationId"], "verif_deadbeef");
});

test("audit: a publication with NO verification identity is still recorded, without inventing one", async () => {
  const noVerif = session();
  (noVerif.attempts[0] as unknown as { receipt: Record<string, unknown> }).receipt["verification"] = { verdict: "pass" };
  const s = sink();
  await recordBuildSessionReceipts(noVerif, REPO, s);
  assert.equal(promote(s).length, 1);
  assert.equal(promote(s)[0]!.metadata!["verificationId"], undefined, "absent evidence is recorded as absent");
});

test("audit: CONCURRENT builds cannot misattribute — each record names its own repo, run and refs", async () => {
  // Two sessions, two repositories, one shared receipt log (the real arrangement).
  const s = sink();
  const a = session();
  const b = session();
  (b.attempts[0] as unknown as { runId: string }).runId = "run_xyz";
  (b.attempts[0] as unknown as { receipt: { promotion: Record<string, unknown> } }).receipt.promotion = {
    ...PROMOTION, promotionId: "prom_2", beforeRef: "bbase", afterRef: "blanded", targetBranch: "release",
  };
  await Promise.all([recordBuildSessionReceipts(a, "/repos/alpha", s), recordBuildSessionReceipts(b, "/repos/beta", s)]);

  const records = promote(s);
  assert.equal(records.length, 2);
  const byRepo = new Map(records.map((r) => [r.metadata!["repository"] as string, r]));
  // Each anchor points at its OWN repo and branch. `undo --latest` scopes by the repo in the
  // change target, so a crossed attribution here would revert the wrong repository.
  assert.equal(byRepo.get("/repos/alpha")!.changes!.find((c) => c.kind === "state")!.target, "/repos/alpha#main");
  assert.equal(byRepo.get("/repos/beta")!.changes!.find((c) => c.kind === "state")!.target, "/repos/beta#release");
  assert.equal(byRepo.get("/repos/beta")!.metadata!["runId"], "run_xyz");
  assert.notEqual(byRepo.get("/repos/alpha")!.metadata!["promotionId"], byRepo.get("/repos/beta")!.metadata!["promotionId"]);
});

test("audit: a receipt that FAILED to write is never reported as written", async () => {
  // The caller warns the operator on this. Claiming success would tell them a landed commit is
  // recoverable when `ikbi undo` will not be able to find it.
  const s = sink(true);
  const out = await recordBuildSessionReceipts(session(), REPO, s);
  assert.equal(out.runSummary, "failed");
  assert.equal(out.promotion, "failed");
  assert.notEqual(out.promotion, "written");
});

test("audit: `not_applicable` is distinguishable from `written` — an unpublished run is not recoverable", async () => {
  const s = sink();
  const out = await recordBuildSessionReceipts(session({ promotion: undefined, outcome: "failed" }), REPO, s);
  // Three states, three meanings: it landed and was recorded; it landed and was not; nothing landed.
  assert.equal(out.promotion, "not_applicable");
  assert.equal(out.runSummary, "written");
});

test("audit: the reversible change is the ONLY change on either receipt", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  assert.deepEqual(summary(s)[0]!.changes, []);
  assert.equal(promote(s)[0]!.changes!.length, 1);
});
