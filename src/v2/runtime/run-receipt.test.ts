/**
 * THE V2 ENGINE'S ENTRY IN THE OPERATOR RECEIPT LOG.
 *
 * The defect these pin was silent and total: after the v2 cutover a canonical `ikbi build` that
 * published a commit to `main` wrote nothing to the receipt log but its verifier's governed-exec
 * lines, so `ikbi inspect <run-id>` answered INSPECT_NOT_FOUND and `ikbi undo --latest` answered
 * "no revertible promotion found in the receipt log" — while the commit sat on the branch.
 *
 * The shapes asserted here are not this module's preferences. They are what `src/cli/undo.ts` and
 * `src/cli/inspect.ts` READ, and a receipt that does not match them is a receipt neither command
 * can use.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { recordBuildSessionReceipts, V2_RECEIPT_IDENTITY } from "./run-receipt.js";
import type { ReceiptInput } from "../../core/receipt/contract.js";
import type { V2BuildSessionResult } from "../core/session.js";

const REPO = "/lab-fake/some/repo";

/** A sink that records what it was asked to append. `fail` makes every append throw. */
function sink(fail = false) {
  const appended: ReceiptInput[] = [];
  const identities: unknown[] = [];
  return {
    appended,
    identities,
    append: async (input: ReceiptInput, identity: unknown) => {
      if (fail) throw new Error("receipt store unwritable");
      appended.push(input);
      identities.push(identity);
      return undefined;
    },
  };
}

/** A session result carrying only what the recorder reads. */
function session(opts: {
  outcome?: string;
  promotion?: Record<string, unknown> | undefined;
  verdict?: string;
  attempts?: number;
  recovery?: string[];
} = {}): V2BuildSessionResult {
  const promotion = "promotion" in opts ? opts.promotion : {
    promotionId: "prom_1", candidateId: "cand_1", targetBranch: "main", strategy: "clean_ref_cas",
    beforeRef: "aaaaaaa", afterRef: "bbbbbbb", publishedTree: "tree_1",
    worktreeSynced: true, stashed: false, idempotent: false, degraded: false, postCasVerified: true,
  };
  return {
    buildSessionId: "sess_1",
    outcome: { kind: opts.outcome ?? "accepted" },
    recoveryDecisions: (opts.recovery ?? ["stop_accepted"]).map((kind) => ({ kind })),
    receipt: { totalAttempts: opts.attempts ?? 1 },
    ledger: [],
    attempts: [{
      runId: "run_abc",
      taskId: "task_abc",
      journal: [{ from: "pending", to: "preflight" }, { from: "publication", to: "terminal" }],
      receipt: {
        candidate: { candidateId: "cand_1", workspaceId: "ws_1", treeId: "tree_1" },
        verification: { verdict: opts.verdict ?? "pass" },
        ...(promotion !== undefined ? { promotion } : {}),
      },
    }],
  } as unknown as V2BuildSessionResult;
}

const byOp = (s: ReturnType<typeof sink>, op: string): ReceiptInput | undefined =>
  s.appended.find((r) => r.operation === op);

test("run receipt: a published run writes BOTH a run.summary and a workspace.promote", async () => {
  const s = sink();
  const out = await recordBuildSessionReceipts(session(), REPO, s);
  // `advisories` is "not_applicable" here: this session gathered none, which is the ordinary
  // Bokahli-off case and a different fact from "gathered some and failed to write them".
  assert.deepEqual(out, { runSummary: "written", promotion: "written", advisories: "not_applicable" });
  assert.deepEqual(s.appended.map((r) => r.operation), ["run.summary", "workspace.promote"]);
});

test("run receipt: the promote change is the exact shape `ikbi undo` parses", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  const promote = byOp(s, "workspace.promote")!;

  assert.equal(promote.outcome.status, "success", "undo filters on a SUCCESSFUL promote");
  const change = promote.changes!.find((c) => c.kind === "state")!;
  // undo's `stateChange()` requires kind "state", before.ref, after.ref, and a "#" in the target.
  assert.ok(change !== undefined);
  assert.equal(change.target, `${REPO}#main`, "undo splits repo and branch on the LAST '#'");
  assert.equal(change.before!.ref, "aaaaaaa");
  assert.equal(change.after!.ref, "bbbbbbb");
  assert.equal(change.inverse!.operation, "git.update-ref");
  assert.deepEqual(change.inverse!.args, { ref: "refs/heads/main", to: "aaaaaaa" });
});

test("run receipt: the run.summary carries the runId `ikbi inspect` resolves through", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  const summary = byOp(s, "run.summary")!;

  // inspect matches on requestId OR metadata.runId — both are supplied so neither path can miss.
  assert.equal(summary.requestId, "run_abc");
  assert.equal(summary.metadata!.runId, "run_abc");
  assert.equal(summary.metadata!.taskId, "task_abc");
  assert.equal(summary.metadata!.repository, REPO);
  assert.equal(summary.metadata!.verification, "pass");
  assert.equal(summary.metadata!.promotion, "promoted");
  assert.equal(summary.metadata!.promoted, true);
  assert.equal(summary.metadata!.phase, "terminal");
  assert.equal(summary.project, REPO, "inspect falls back to `project` for the repository");
});

test("run receipt: a WITHHELD run writes no promote — nothing may look undoable", async () => {
  const s = sink();
  const out = await recordBuildSessionReceipts(session({ outcome: "failed", promotion: undefined, verdict: "fail" }), REPO, s);

  assert.equal(out.promotion, "not_applicable");
  assert.deepEqual(s.appended.map((r) => r.operation), ["run.summary"]);
  const summary = byOp(s, "run.summary")!;
  assert.equal(summary.outcome.status, "failure");
  assert.equal(summary.metadata!.promotion, "not_attempted");
  assert.equal(summary.metadata!.promoted, false);
});

test("run receipt: an unmoved ref is NOT a publication, even with a promotion record", async () => {
  // An idempotent re-publish of an already-authoritative tree moved nothing. Offering an undo for
  // it would point the operator at reverting a change that never happened.
  const s = sink();
  const same = { promotionId: "p", candidateId: "c", targetBranch: "main", strategy: "clean_ref_cas",
    beforeRef: "same", afterRef: "same", publishedTree: "t", worktreeSynced: true, stashed: false,
    idempotent: true, degraded: false, postCasVerified: true };
  const out = await recordBuildSessionReceipts(session({ promotion: same }), REPO, s);
  assert.equal(out.promotion, "not_applicable");
  assert.equal(byOp(s, "workspace.promote"), undefined);
});

test("run receipt: a promotion missing its refs is not treated as revertible", async () => {
  const s = sink();
  const partial = { promotionId: "p", candidateId: "c", targetBranch: "main", strategy: "clean_ref_cas",
    publishedTree: "t", worktreeSynced: false, stashed: false, idempotent: false, degraded: true, postCasVerified: false };
  const out = await recordBuildSessionReceipts(session({ promotion: partial }), REPO, s);
  assert.equal(out.promotion, "not_applicable", "an undo anchor with no before/after ref is not an anchor");
});

test("run receipt: a stashed worktree is recorded — the operator is never told to guess", async () => {
  const s = sink();
  const stashed = { promotionId: "p", candidateId: "c", targetBranch: "main", strategy: "clean_ref_cas",
    beforeRef: "a", afterRef: "b", publishedTree: "t", worktreeSynced: true, stashed: true,
    idempotent: false, degraded: false, postCasVerified: true };
  await recordBuildSessionReceipts(session({ promotion: stashed }), REPO, s);
  // Late local work is stashed and NEVER auto-popped, so the record has to say so.
  assert.equal(byOp(s, "workspace.promote")!.metadata!.stashed, true);
});

test("run receipt: a degraded landing is still recorded as revertible", async () => {
  // The ref MOVED. Withholding the undo anchor because bookkeeping degraded would leave the
  // operator with a landed commit and no supported way back.
  const s = sink();
  const degraded = { promotionId: "p", candidateId: "c", targetBranch: "main", strategy: "clean_ref_cas",
    beforeRef: "a", afterRef: "b", publishedTree: "t", worktreeSynced: false, stashed: false,
    idempotent: false, degraded: true, postCasVerified: false };
  const out = await recordBuildSessionReceipts(session({ promotion: degraded }), REPO, s);
  assert.equal(out.promotion, "written");
  assert.equal(byOp(s, "workspace.promote")!.metadata!.degraded, true);
  assert.equal(byOp(s, "workspace.promote")!.metadata!.postCasVerified, false);
});

test("run receipt: a store that cannot be written is REPORTED, never thrown", async () => {
  // The git ref is the authoritative landing proof. A failed receipt must not turn a publication
  // that already happened into an exception on the way out.
  const s = sink(true);
  const out = await recordBuildSessionReceipts(session(), REPO, s);
  assert.deepEqual(out, { runSummary: "failed", promotion: "failed", advisories: "not_applicable" });
});

test("run receipt: receipts are attributed to the ENGINE, not to a model", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  // A publication is a governed decision the model never made.
  for (const id of s.identities) assert.deepEqual(id, V2_RECEIPT_IDENTITY);
  assert.equal(V2_RECEIPT_IDENTITY.agentId, "ikbi-v2");
});

test("run receipt: the recovery trail is recorded for a multi-attempt session", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session({ attempts: 3, recovery: ["retry_authorized", "retry_authorized", "stop_accepted"] }), REPO, s);
  const summary = byOp(s, "run.summary")!;
  assert.equal(summary.metadata!.attempts, 3);
  assert.deepEqual(summary.metadata!.recovery, ["retry_authorized", "retry_authorized", "stop_accepted"]);
});

test("run receipt: the run.summary carries no changes — one ref move, one undo anchor", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), REPO, s);
  // Two receipts describing the same ref move would give `undo --latest` two anchors for one event.
  assert.deepEqual(byOp(s, "run.summary")!.changes, []);
});

test("run receipt: a session with no attempts fails closed rather than inventing a record", async () => {
  const s = sink();
  const empty = { buildSessionId: "s", outcome: { kind: "failed" }, recoveryDecisions: [], receipt: { totalAttempts: 0 }, ledger: [], attempts: [] } as unknown as V2BuildSessionResult;
  const out = await recordBuildSessionReceipts(empty, REPO, s);
  assert.deepEqual(out, { runSummary: "failed", promotion: "not_applicable", advisories: "not_applicable" });
  assert.equal(s.appended.length, 0);
});
