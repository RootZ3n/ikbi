/**
 * CRITIC INVOCATION ACCOUNTING (V2-019/HIGH-02).
 *
 * THE INVARIANT. Every provider request authorized to reach the wire has its InvocationId recorded
 * in the SESSION attempt ledger BEFORE the send. Success and failure are a separate question: the
 * `maxInvocations` cap counts WIRE ATTEMPTS, so a call that really dialled the provider and then
 * failed consumes its slot instead of being a free retry.
 *
 * THE DEFECT THIS PINS. `judgeCandidate` used to mint its own InvocationId internally and, on a
 * transport failure, return only `attemptedInvocation: true`. The identity never escaped, so
 * `SessionCostController.recordAttempt` was never called for it. Real provider sends could then
 * exceed the ledger, and recovery could push the session past `maxInvocations` — the provider had
 * been dialled three times while the receipt said two.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { judgeCandidate } from "./critic.js";
import { SessionCostController, V2_SHIPPED_PRICING, buildCostBudgetPolicy } from "./cost.js";
import type { CandidateRecord } from "./candidate.js";
import type { CandidateDiff, CandidateDiffSource } from "./candidate-diff.js";
import type { InvocationTransport, TransportOutcome } from "./invocation.js";
import type { ModelResolutionDecision } from "./resolver.js";
import type { UntrustedBoundary } from "./builder.js";
import type { V2CandidateId, V2InvocationId, V2RunId, V2SnapshotDigest, V2TaskId, V2VerificationId } from "./identity.js";
import type { RunVerificationSummary, VerificationRecord } from "./verification.js";

const RUN = "run_acct" as V2RunId;
const TASK = "task_acct" as V2TaskId;
const TREE = "a".repeat(40);
const SNAP = ("snap" + "0".repeat(60)) as V2SnapshotDigest;

const candidate = {
  candidateId: "cand".repeat(16) as V2CandidateId,
  runId: RUN,
  sourceSnapshotId: SNAP,
  workspaceId: "ws_1",
  builderDecisionId: "bdec",
  invocationIds: [],
  mutationIds: [],
  changedPaths: ["src/a.ts"],
  tree: { treeId: TREE, baseTreeId: "b".repeat(40), startTree: "s".repeat(40), materializedStateDigest: "m".repeat(64), changed: true },
  completion: "finished",
  claim: { summary: "changed src/a.ts", believesComplete: true },
  metadata: { turns: 3, toolCalls: 3, toolFailures: 0, startedAt: 0, endedAt: 1 },
} as unknown as CandidateRecord;

const verification = {
  verificationId: "v".repeat(64) as V2VerificationId,
  runId: RUN,
  candidateId: candidate.candidateId,
  candidateTreeId: TREE,
  planId: "p".repeat(64),
  treeBeforeChecks: TREE,
  treeAfterChecks: TREE,
  checks: [],
  verdict: "pass",
  workspaceDisposition: "retained",
  startedAt: 0,
  endedAt: 1,
} as unknown as VerificationRecord;

const verificationSummary: RunVerificationSummary = {
  verificationId: verification.verificationId,
  runId: RUN,
  candidateId: candidate.candidateId,
  candidateTreeId: TREE,
  planId: "p".repeat(64),
  verdict: "pass",
  treeBeforeChecks: TREE,
  treeAfterChecks: TREE,
  treeUnchanged: true,
  workspaceDisposition: "retained",
  checks: [],
};

const decision = { decisionId: "cdec".repeat(16), runId: RUN, role: "critic", modelId: "m", providerId: "p", providerModelId: "mw" } as unknown as ModelResolutionDecision;
const boundary: UntrustedBoundary = { wrap: ({ content }) => content };
const emptyDiff: CandidateDiff = { diffId: "d".repeat(64) as never, candidateId: candidate.candidateId, sourceSnapshotId: SNAP, fromTree: "s".repeat(40), toTree: TREE, files: [], empty: true, truncated: false };
const diffSource: CandidateDiffSource = { diff: async () => emptyDiff };

const SATISFIED = JSON.stringify({ verdict: "satisfied", summary: "ok", defects: [] });

/** A wire that COUNTS every request it is asked to make — the ground truth for "what was sent". */
function countingWire(behavior: (n: number) => TransportOutcome): { transport: InvocationTransport; requests: () => number } {
  let n = 0;
  return {
    transport: { async send(): Promise<TransportOutcome> { n += 1; return behavior(n); } },
    requests: () => n,
  };
}

const controller = (maxInvocations?: number): SessionCostController =>
  new SessionCostController({
    buildSessionId: "sess_acct",
    catalog: V2_SHIPPED_PRICING,
    policy: buildCostBudgetPolicy({ ...(maxInvocations !== undefined ? { maxInvocations } : {}), behaviorWhenCostUnknown: "allow_unknown" }),
  });

const judge = (transport: InvocationTransport, invocationId: string, admission?: SessionCostController) =>
  judgeCandidate({
    runId: RUN, taskId: TASK, goal: "g", candidate, verification, verificationSummary, workspacePath: "/ws",
    decision, transport, boundary, diffSource, diffBudget: { maxFilesWithHunks: 10, maxHunkChars: 100 },
    probeTree: async () => TREE, invocationId: invocationId as V2InvocationId,
    ...(admission !== undefined ? { admission } : {}),
    maxOutputTokens: 256, timeoutMs: 1000, now: () => 10,
  });

/** How many wire attempts the session has counted (the number `maxInvocations` is compared against). */
const attempted = (c: SessionCostController): number =>
  (c as unknown as { attemptedIds: Set<string> }).attemptedIds.size;

// ── THE ACCOUNTING MATRIX ────────────────────────────────────────────────────

test("HIGH-02: critic SUCCESS — exactly one attempted slot and one retained record", async () => {
  const wire = countingWire(() => ({ ok: true, response: { content: SATISFIED, finishReason: "stop", servedModelId: "mw", attempts: 1 } }));
  const c = controller();
  const r = await judge(wire.transport, "inv_ok", c);

  assert.ok(r.ok);
  assert.equal(wire.requests(), 1);
  assert.equal(attempted(c), 1, "recorded exactly once — recordAttempt is idempotent per id");
  assert.equal(r.generation.invocation.invocationId, "inv_ok", "the record carries the id the CALLER minted");
  c.charge(r.generation.invocation);
  assert.equal(attempted(c), 1, "charging the same invocation does not double-count the attempt");
});

test("HIGH-02: critic TRANSPORT FAILURE — the attempted id ESCAPES, and no record is fabricated", async () => {
  const wire = countingWire(() => ({ ok: false, failure: { code: "invocation.transport_failure", message: "down", providerId: "p", attempts: 1 } }));
  const c = controller();
  const r = await judge(wire.transport, "inv_dead", c);

  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(wire.requests(), 1, "the provider really was dialled");
  assert.equal(r.attemptedInvocation, true);
  assert.equal(r.attemptedInvocationId, "inv_dead", "the identity of the failed call is VISIBLE to the caller");
  assert.equal(r.invocation, undefined, "no InvocationRecord is fabricated for a call that returned nothing");
  assert.equal(attempted(c), 1, "the failed call consumed its slot — it is not a free retry");
});

test("HIGH-02: critic PARSE FAILURE after a successful send — counted AND charged", async () => {
  const wire = countingWire(() => ({ ok: true, response: { content: "not json at all", finishReason: "stop", servedModelId: "mw", attempts: 1 } }));
  const c = controller();
  const r = await judge(wire.transport, "inv_garbage", c);

  assert.ok(!r.ok);
  assert.equal(wire.requests(), 1);
  assert.equal(r.attemptedInvocation, true);
  assert.equal(r.attemptedInvocationId, "inv_garbage");
  assert.ok(r.invocation !== undefined, "the wire call SUCCEEDED — its usage is real and must be accounted");
  assert.equal(r.invocation.invocationId, "inv_garbage");
  c.charge(r.invocation);
  assert.equal(attempted(c), 1, "exactly one slot for one send");
  assert.equal(c.sessionSummary().totalInvocations, 1, "the call is in the ledger even though no CriticRecord exists");
});

test("HIGH-02: SERVED IDENTITY MISMATCH after the wire — the attempt is still counted exactly once", async () => {
  // The provider answered, but as a DIFFERENT model than the one authorized.
  const wire = countingWire(() => ({ ok: true, response: { content: SATISFIED, finishReason: "stop", servedModelId: "some-other-model", attempts: 1 } }));
  const c = controller();
  const r = await judge(wire.transport, "inv_wrongmodel", c);

  assert.equal(wire.requests(), 1);
  assert.equal(attempted(c), 1, "one send, one slot — regardless of how the authority classifies the answer");
  const escaped = r.ok ? r.generation.invocation.invocationId : (r.attemptedInvocationId ?? r.invocation?.invocationId);
  assert.equal(escaped, "inv_wrongmodel", "the attempted identity escapes on every post-wire outcome");
});

// ── THE COMPOSED CAP PROOF ───────────────────────────────────────────────────

test("HIGH-02: maxInvocations=2 — a builder call plus a FAILED critic call exhaust the cap", async () => {
  const c = controller(2);
  const identity = { authorizedModelId: "m", sentProviderId: "p", sentProviderModelId: "mw" };
  const admit = () => c.admitNext({ identity, estimatedInputTokens: 100, maxOutputTokens: 100 });

  // ATTEMPT 1, slot 1 — a builder call that reaches the wire and succeeds.
  assert.equal(admit().admit, true);
  c.recordAttempt("inv_builder_1");
  assert.equal(attempted(c), 1);

  // ATTEMPT 1, slot 2 — a critic call that reaches the wire and FAILS in transport.
  assert.equal(admit().admit, true, "the second call is still within the cap");
  const wire = countingWire(() => ({ ok: false, failure: { code: "invocation.transport_failure", message: "down", providerId: "p", attempts: 1 } }));
  const judged = await judge(wire.transport, "inv_critic_1", c);
  assert.ok(!judged.ok);
  assert.equal(judged.attemptedInvocationId, "inv_critic_1");
  assert.equal(attempted(c), 2, "the failed critic call consumed slot 2");

  // ATTEMPT 2 — recovery wants another call. It must be DENIED BEFORE the wire.
  const denied = admit();
  assert.equal(denied.admit, false, "the cap is exhausted by WIRE ATTEMPTS, not by successful records");
  assert.equal(attempted(c), 2);

  // GROUND TRUTH: the fake provider saw exactly the calls the ledger claims.
  assert.equal(wire.requests(), 1, "this wire served exactly one request");
  const summary = c.sessionSummary();
  assert.equal(summary.failedInvocationsWithoutUsage >= 0, true);
  assert.equal(summary.totalKnownCostMicroUsd, 0, "a call that returned no usage is never priced as $0 spend it did not make");
});

test("HIGH-02: the whole loop — 2 authorized sends, a denied third, and the provider saw exactly 2", async () => {
  const c = controller(2);
  const identity = { authorizedModelId: "m", sentProviderId: "p", sentProviderModelId: "mw" };
  const admit = () => c.admitNext({ identity, estimatedInputTokens: 100, maxOutputTokens: 100 });

  // ONE shared wire counts every request the whole session makes.
  const wire = countingWire((n) =>
    n === 1
      ? { ok: true, response: { content: SATISFIED, finishReason: "stop", servedModelId: "mw", attempts: 1 } }
      : { ok: false, failure: { code: "invocation.transport_failure", message: "down", providerId: "p", attempts: 1 } },
  );

  assert.equal(admit().admit, true);
  const first = await judge(wire.transport, "inv_a", c);
  assert.ok(first.ok);
  c.charge(first.generation.invocation);

  assert.equal(admit().admit, true);
  const second = await judge(wire.transport, "inv_b", c);
  assert.ok(!second.ok);
  assert.equal(second.attemptedInvocationId, "inv_b");

  // The recovery attempt never reaches the transport.
  assert.equal(admit().admit, false);
  assert.equal(wire.requests(), 2, "actual provider requests MUST remain exactly 2 — not 3");
  assert.equal(attempted(c), 2, "and the session attempted-ledger agrees with the provider");
});

// ── THE STATIC GUARD ─────────────────────────────────────────────────────────

test("HIGH-02 guard: the critic records its InvocationId BEFORE the transport send", () => {
  const raw = readFileSync(fileURLToPath(new URL("./critic.ts", import.meta.url)), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const recordAt = src.indexOf("admission?.recordAttempt(");
  const sendAt = src.indexOf("await invokeAuthorized(");
  assert.ok(recordAt > 0, "the critic must record the attempt through the session admission authority");
  assert.ok(sendAt > 0, "the critic must reach the wire through the ONE invocation authority");
  assert.ok(recordAt < sendAt, "the attempt is recorded BEFORE the send, never after it returns");

  // The id is the CALLER's — the critic may not mint its own occurrence identity any more.
  assert.equal(/mintInvocationId/.test(src), false, "the critic no longer hides the invocation identity it uses");
  assert.ok(/readonly invocationId: V2InvocationId;/.test(raw), "the InvocationId is an INPUT to judgeCandidate");

  // There is no second, critic-private cost ledger.
  assert.equal(/new SessionCostController/.test(src), false, "the critic uses the session's admission, never its own wallet");
});

test("HIGH-02 guard: the run spine ledgers a wire-reaching critic call that produced no record", () => {
  const raw = readFileSync(fileURLToPath(new URL("./run.ts", import.meta.url)), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(src.includes("judged.attemptedInvocationId"), "the run must consume the attempted id");
  assert.ok(/admission: deps\.admission/.test(src), "the run hands the SAME session admission to the critic");
});
