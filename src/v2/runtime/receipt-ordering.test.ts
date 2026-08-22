/**
 * RECEIPT ORDERING AND AUTHORITY SEPARATION.
 *
 * The question an auditor asks of this log is not "is everything present" but "could a reader
 * mistake one layer's claim for another's". An advisory that an unqualified model produced must
 * never be readable as authorization, and a promotion must never appear where the evidence
 * forbade one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { recordBuildSessionReceipts } from "./run-receipt.js";
import type { ReceiptInput } from "../../core/receipt/contract.js";
import type { V2BuildSessionResult } from "../core/session.js";

function sink() {
  const appended: ReceiptInput[] = [];
  return { appended, append: async (i: ReceiptInput) => { appended.push(i); return undefined; } };
}

const PROMOTION = {
  promotionId: "prom_1", candidateId: "c", candidateTreeId: "t", targetBranch: "main", strategy: "cas",
  beforeRef: "base0", afterRef: "land9", publishedTree: "t",
  worktreeSynced: true, stashed: false, idempotent: false, degraded: false, postCasVerified: true,
};

function session(over: { promotion?: Record<string, unknown> | undefined; verdict?: string; outcome?: string; sessionId?: string; runId?: string } = {}): V2BuildSessionResult {
  const promotion = "promotion" in over ? over.promotion : PROMOTION;
  return {
    buildSessionId: over.sessionId ?? "sess_1",
    outcome: { kind: over.outcome ?? "accepted" },
    recoveryDecisions: [{ kind: "stop_accepted" }],
    receipt: { totalAttempts: 1 },
    ledger: [],
    attempts: [{
      runId: over.runId ?? "run_1", taskId: "task_1", journal: [{ from: "publication", to: "terminal" }],
      receipt: {
        candidate: { candidateId: "c", workspaceId: "w", treeId: "t" },
        verification: { verdict: over.verdict ?? "pass", verificationId: "v1" },
        ...(promotion !== undefined ? { promotion } : {}),
      },
    }],
  } as unknown as V2BuildSessionResult;
}

const advisory = (over: Record<string, unknown> = {}) =>
  ({ hook: "PRE_BUILD_RECON", disposition: "accepted", suppliedToPrimaryProvider: true, buildSessionId: "sess_1", ...over }) as never;

const ops = (s: ReturnType<typeof sink>) => s.appended.map((r) => r.operation);
const one = (s: ReturnType<typeof sink>, op: string) => s.appended.filter((r) => r.operation === op);

test("ordering: one publication produces EXACTLY one promotion receipt", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), "/repo", s, undefined, [advisory()]);
  assert.equal(one(s, "workspace.promote").length, 1);
  assert.equal(one(s, "run.summary").length, 1);
  assert.equal(one(s, "local.advisory").length, 1);
});

test("ordering: the advisory is recorded BEFORE the promotion it did not authorize", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), "/repo", s, undefined, [advisory()]);
  const order = ops(s);
  assert.deepEqual(order, ["run.summary", "local.advisory", "workspace.promote"]);
  // The promote is last because it is the only entry that describes an irreversible act; anything
  // appended after it would read as having happened under its authority.
  assert.equal(order.at(-1), "workspace.promote");
});

test("authority: an ACCEPTED advisory is not promotion authorization", async () => {
  // The clearest form of the claim: an accepted advisory on a run that published NOTHING must not
  // produce a promotion receipt.
  const s = sink();
  const out = await recordBuildSessionReceipts(
    session({ promotion: undefined, outcome: "failed", verdict: "fail" }), "/repo", s, undefined, [advisory()],
  );
  assert.equal(out.promotion, "not_applicable");
  assert.equal(one(s, "workspace.promote").length, 0);
  assert.equal(one(s, "local.advisory").length, 1, "the advisory is still recorded — it just authorized nothing");
});

test("authority: a promotion receipt carries NO advisory field, and an advisory carries NO change", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), "/repo", s, undefined, [advisory()]);
  const promote = one(s, "workspace.promote")[0]!;
  const adv = one(s, "local.advisory")[0]!;
  // A promotion that cited an advisory would invite reading the advisory as its justification.
  assert.equal((promote.metadata as Record<string, unknown>)["advisories"], undefined);
  assert.equal((promote.metadata as Record<string, unknown>)["authorityLayer"], undefined);
  assert.equal((adv.metadata as Record<string, unknown>)["authorityLayer"], "local_advisory");
  // An advisory with a `changes` entry would look reversible, implying it had done something.
  assert.deepEqual(adv.changes, []);
  assert.equal(promote.changes!.length, 1);
});

test("authority: a REJECTED advisory stays visible even when the build SUCCEEDED", async () => {
  // The failure mode this pins: a green build burying the fact that local evidence was discarded.
  const s = sink();
  await recordBuildSessionReceipts(session(), "/repo", s, undefined, [
    advisory({ disposition: "rejected", suppliedToPrimaryProvider: false, detail: "citation_unresolved" }),
    advisory({ hook: "POST_CANDIDATE_DIFF_SUMMARY", disposition: "quarantined", suppliedToPrimaryProvider: false }),
  ]);
  const adv = one(s, "local.advisory")[0]!;
  const m = adv.metadata as Record<string, unknown>;
  assert.equal(m["advisoryCount"], 2);
  assert.equal(m["acceptedCount"], 0, "a successful build must not inflate the accepted count");
  assert.equal(m["suppliedToPrimaryCount"], 0);
  assert.equal(adv.outcome.status, "success", "the RECEIPT wrote successfully — the advisories did not");
  assert.match(adv.outcome.detail!, /0\/2 local advisory result\(s\) accepted/);
});

test("authority: the promotion is anchored to the VERIFICATION that authorized it", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), "/repo", s, undefined, [advisory()]);
  const m = one(s, "workspace.promote")[0]!.metadata as Record<string, unknown>;
  assert.equal(m["verificationId"], "v1");
  assert.equal(m["verificationVerdict"], "pass");
  assert.equal(m["baseCommit"], "base0");
  assert.equal(m["promotedCommit"], "land9");
});

test("undo: the promotion receipt is the one `ikbi undo` selects, and advisories do not confuse it", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), "/repo", s, undefined, [advisory(), advisory({ hook: "POST_CANDIDATE_DIFF_SUMMARY" })]);
  // undo filters: operation === workspace.promote, success, and a state change with before/after
  // refs and a `#` target. Exactly one entry in this log matches.
  const undoable = s.appended.filter(
    (r) => r.operation === "workspace.promote" && r.outcome.status === "success" &&
      r.changes?.some((c) => c.kind === "state" && c.before?.ref !== undefined && c.after?.ref !== undefined && c.target.includes("#")),
  );
  assert.equal(undoable.length, 1);
  assert.equal(undoable[0]!.changes!.find((c) => c.kind === "state")!.target, "/repo#main");
});

test("concurrency: one build's advisories can never attach to another build's receipt", async () => {
  const s = sink();
  await Promise.all([
    recordBuildSessionReceipts(session({ sessionId: "sess_A", runId: "run_A" }), "/repos/alpha", s, undefined, [advisory({ buildSessionId: "sess_A" })]),
    recordBuildSessionReceipts(session({ sessionId: "sess_B", runId: "run_B" }), "/repos/beta", s, undefined, [advisory({ buildSessionId: "sess_B", hook: "POST_CANDIDATE_DIFF_SUMMARY" })]),
  ]);
  const advisories = one(s, "local.advisory");
  assert.equal(advisories.length, 2);
  for (const a of advisories) {
    const m = a.metadata as Record<string, unknown>;
    const carried = m["advisories"] as { buildSessionId: string }[];
    // Every advisory in a receipt names the same session that receipt is for.
    for (const c of carried) assert.equal(c.buildSessionId, m["buildSessionId"], "an advisory was attached to the wrong build");
    assert.equal(a.requestId, m["runId"]);
  }
  // And the two receipts name different repositories, so neither can be read against the other.
  assert.notEqual((advisories[0]!.metadata as Record<string, unknown>)["repository"], (advisories[1]!.metadata as Record<string, unknown>)["repository"]);
});

test("binding: every advisory binds the parent build session and run", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), "/repo", s, undefined, [advisory()]);
  const m = one(s, "local.advisory")[0]!.metadata as Record<string, unknown>;
  assert.equal(m["buildSessionId"], "sess_1");
  assert.equal(m["runId"], "run_1");
  assert.equal(m["taskId"], "task_1");
  for (const c of m["advisories"] as { buildSessionId: string }[]) assert.equal(c.buildSessionId, "sess_1");
});

test("binding: the prompt binding is recorded on the advisory layer, not on the promotion", async () => {
  const s = sink();
  await recordBuildSessionReceipts(session(), "/repo", s, undefined, [advisory()],
    { canonicalGoalSha256: "sha256:goal", advisoryPacketDigests: ["sha256:pkt"], advisoryResultDigests: ["sha256:res"], hooks: ["PRE_BUILD_RECON@1"], validators: ["repo-recon@1"] });
  const adv = one(s, "local.advisory")[0]!.metadata as Record<string, unknown>;
  const binding = adv["promptBinding"] as Record<string, unknown>;
  assert.equal(binding["canonicalGoalSha256"], "sha256:goal");
  assert.deepEqual(binding["hooks"], ["PRE_BUILD_RECON@1"]);
  // The promotion says nothing about prompts: what shaped a prompt is not what authorized a ref.
  assert.equal((one(s, "workspace.promote")[0]!.metadata as Record<string, unknown>)["promptBinding"], undefined);
});
