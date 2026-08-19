/**
 * THE BUILD SESSION CONTROLLER, in isolation — the RETRY PROOFS.
 *
 * A session composes complete attempts under the ONE recovery authority. These tests drive
 * `executeV2BuildSession` with hermetic, STATEFUL fakes (a publisher/checkRunner/transport that
 * behaves differently on attempt 1 vs attempt 2) and prove:
 *
 *   - an environmental condition (moved target, CAS conflict, verification timeout, transient
 *     provider failure) is auto-retried with a FRESH attempt — a new RunId, a new source
 *     snapshot, a whole new evidence chain — and NO evidence crosses the boundary;
 *   - the retry happened because RECOVERY authorized a new attempt, not because a lower
 *     subsystem quietly tried again (invocation stays single-shot, no provider fallback);
 *   - an adverse JUDGMENT (verification fail, critic defects) is NEVER retried;
 *   - a dirty source requires an operator; the budget is bounded; a degraded landing is
 *     reconciliation, never a re-publish; and configuration is frozen across attempts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { executeV2BuildSession, type V2BuildSessionDeps } from "./session.js";
import { buildRecoveryPolicy } from "./recovery.js";
import { createSequentialIdFactory } from "./identity.js";
import type { ConfigurationSource } from "./config.js";
import type { InvocationTransport } from "./invocation.js";
import type { PromotionTarget, PublicationOutcome } from "./promotion.js";
import type { RepoProbe } from "./run.js";
import type { SourceSnapshotAuthority } from "./source.js";
import type { WorkspaceAuthority, StateBoundMutationAuthority, V2WorkspaceRecord, WorkspaceDisposition } from "./workspace.js";

const goodRepo: RepoProbe = { inspect: () => ({ exists: true, isDirectory: true, hasGitDir: true }) };

const workingConfiguration: ConfigurationSource = {
  load: async () => ({
    inventory: {
      providers: [{ id: "alpha", introspectable: true, kind: "openai-compatible", baseUrl: "https://alpha.test/v1", credentialRequired: false, credentialPresent: false }],
      models: [{ id: "alpha-1", routes: [{ providerId: "alpha", providerModelId: "a1" }], capabilities: { contextWindow: 100_000, supportsTools: true, reasoningLevel: "medium", speedClass: "medium", provenance: "declared" } }],
    },
    activeProfile: { kind: "none" },
    operatorDefaults: { models: [{ tier: "builder", modelId: "alpha-1", explicit: true }, { tier: "critic", modelId: "alpha-1", explicit: true }] },
  }),
};

/** A transport that finishes the builder immediately and returns a satisfied critic. */
function okTransport(): InvocationTransport {
  return {
    send: async (input) => {
      const isCritic = !input.messages.some((m) => m.role === "tool") && input.messages.some((m) => m.content.includes("critic"));
      const content = isCritic
        ? JSON.stringify({ verdict: "satisfied", summary: "ok", defects: [] })
        : "done";
      const toolCalls = isCritic ? undefined : [{ id: "call_1", name: "finish_candidate", arguments: JSON.stringify({ summary: "done", believesComplete: true }) }];
      return { ok: true, response: { content, finishReason: "stop", attempts: 1, servedModelId: input.providerModelId, ...(toolCalls !== undefined ? { toolCalls } : {}) } } as never;
    },
  };
}

/** Sources that yield a DISTINCT snapshot per capture (a fresh attempt re-captures). */
function statefulSources() {
  let n = 0;
  const captured: string[] = [];
  const authority: SourceSnapshotAuthority = {
    capture: async () => {
      n += 1;
      const snapshotId = (`snap${n}` + "0".repeat(60)).slice(0, 64);
      captured.push(snapshotId);
      return {
        ok: true,
        reader: {
          snapshot: { snapshotId: snapshotId as never, repositoryRoot: "/repo", headCommit: `c${n}`.padEnd(40, "0"), headTree: `t${n}`.padEnd(40, "0"), clean: true, policy: {} as never, entries: [], exclusions: [], counts: {} as never, capturedAt: n },
          read: async () => undefined,
        } as never,
      };
    },
  };
  return { authority, captured, count: () => n };
}

function statefulWorkspaces() {
  const allocated: V2WorkspaceRecord[] = [];
  const dispositions: string[] = [];
  let seq = 0;
  const authority: WorkspaceAuthority = {
    allocate: async ({ runId, source }) => {
      seq += 1;
      const workspace = {
        workspaceId: `ws_${seq}` as never,
        runId,
        donorWorkspaceId: `donor_${seq}`,
        source: { repositoryPath: "/repo", baseBranch: "main", baseCommit: source.headCommit, baseTree: source.headTree, sourceSnapshotId: source.snapshotId, materializedStateDigest: "m".repeat(64), startTree: source.headTree, materializedEntries: 0 },
        path: `/ws/${seq}`,
        status: "allocated" as const,
        allocatedAt: seq,
      };
      allocated.push(workspace);
      return { ok: true, workspace };
    },
    discard: async () => { dispositions.push("discard"); return { kind: "discarded" } as WorkspaceDisposition; },
    retain: async (_w, reason) => { dispositions.push("retain"); return { kind: "retained", reason } as WorkspaceDisposition; },
  };
  return { authority, allocated, dispositions };
}

const fakeMutations: StateBoundMutationAuthority = {
  observe: async () => ({ ok: false, failure: { category: "mutation", code: "x", message: "no", retryable: false } }) as never,
  read: async () => ({ ok: false, failure: { category: "mutation", code: "x", message: "no", retryable: false } }) as never,
  mutate: async () => ({ ok: false, failure: { category: "mutation", code: "x", message: "no", retryable: false } }) as never,
} as never;

/** A publisher whose per-attempt behaviour is scripted by an array of outcomes. */
function scriptedPublisher(outcomes: readonly ("land" | "stale" | "cas" | "degraded")[]) {
  let call = 0;
  const publishCalls: string[] = [];
  const target: PromotionTarget = {
    liveHead: async (t) => {
      // On a "stale" attempt the live head has moved off the authorized base.
      return outcomes[call] === "stale" ? "moved".repeat(8) : t.baseCommit;
    },
    treeOfCommit: async () => "live".repeat(10),
    targetCheckout: async () => ({ clean: true }),
    publish: async (input): Promise<PublicationOutcome> => {
      const kind = outcomes[call];
      call += 1;
      publishCalls.push(input.candidateTreeId);
      if (kind === "cas") return { kind: "cas_conflict", observedHead: "race".repeat(10) };
      if (kind === "degraded") return { kind: "landed_desynced", beforeRef: input.expectedHead, afterCommit: "p".repeat(40), publishedTree: input.candidateTreeId, detail: "sync failed" };
      return { kind: "landed", beforeRef: input.expectedHead, afterCommit: "p".repeat(40), publishedTree: input.candidateTreeId, worktreeSynced: true, stashed: false };
    },
  };
  // A "stale" attempt never reaches publish (refused before). Advance the call cursor when the
  // liveHead probe reveals staleness by consuming it there instead.
  const wrapped: PromotionTarget = {
    ...target,
    liveHead: async (t) => {
      const kind = outcomes[call];
      if (kind === "stale") { call += 1; return "moved".repeat(8); }
      return t.baseCommit;
    },
  };
  return { target: wrapped, publishCalls };
}

const CHECK_PASS = { launched: true as const, exitCode: 0, timedOut: false, durationMs: 1, outputSha256: "0".repeat(64), outputExcerpt: "" };

function baseDeps(over: Partial<V2BuildSessionDeps> = {}): V2BuildSessionDeps {
  const sources = over.sources !== undefined ? { authority: over.sources, captured: [] as string[], count: () => 0 } : statefulSources();
  const ws = statefulWorkspaces();
  return {
    configuration: workingConfiguration,
    contextSources: [],
    transport: okTransport(),
    workspaces: ws.authority,
    mutations: fakeMutations,
    sources: sources.authority,
    buildTools: () => ({ execute: async () => ({ outcome: { kind: "rejected" as const, reason: "unknown_tool" as const, detail: "no tools" } }) }),
    untrustedBoundary: { wrap: (i: { content: string }) => i.content },
    checksSource: { resolve: async () => ({ ok: true as const, source: "default" as const, checks: [{ name: "t", command: "x", args: [] }] }) },
    checkRunner: { run: async () => CHECK_PASS },
    treeProbe: { treeOf: async (p: string) => `tree${p.slice(-1)}`.padEnd(40, "0") },
    candidateDiff: { diff: async (i: { candidateId: string; sourceSnapshotId: string; fromTree: string; toTree: string }) => ({ diffId: "d".repeat(64) as never, candidateId: i.candidateId as never, sourceSnapshotId: i.sourceSnapshotId as never, fromTree: i.fromTree, toTree: i.toTree, files: [], empty: true, truncated: false }) },
    captureTree: async (w: V2WorkspaceRecord) => ({ ok: true as const, tree: { treeId: `tree${w.path.slice(-1)}`.padEnd(40, "0"), baseTreeId: w.source.baseTree, startTree: `tree${w.path.slice(-1)}`.padEnd(40, "0"), materializedStateDigest: "m".repeat(64), changed: true } }),
    publisher: scriptedPublisher(["land"]).target,
    probe: goodRepo,
    now: (() => { let t = 0; return () => (t += 1); })(),
    attemptIdFactory: (n: number) => createSequentialIdFactory(`att${n}`),
    ...over,
  };
}

const build = { goal: "do a thing", repoPath: "/repo" };

// ── environmental retries ─────────────────────────────────────────────────────

test("session: a MOVED target is auto-retried — a fresh attempt lands, session accepted", async () => {
  const sources = statefulSources();
  const ws = statefulWorkspaces();
  const pub = scriptedPublisher(["stale", "land"]);
  const session = await executeV2BuildSession(build, baseDeps({ sources: sources.authority, workspaces: ws.authority, publisher: pub.target }));

  assert.equal(session.attempts.length, 2, "one automatic recovery attempt");
  assert.equal(session.outcome.kind, "accepted", "the fresh attempt landed");
  // Attempt 1 was withheld(target_moved) → recovery authorized a retry; attempt 2 accepted.
  assert.equal(session.recoveryDecisions[0]!.kind, "retry_fresh_attempt");
  assert.equal(session.recoveryDecisions[0]!.trigger, "target_moved");
  assert.equal(session.recoveryDecisions[1]!.kind, "stop_accepted");
  // A FRESH source snapshot was captured for the second attempt — no recapture inside a RunId.
  assert.equal(sources.count(), 2, "each attempt captured its own snapshot");
  assert.notEqual(session.attempts[0]!.runId, session.attempts[1]!.runId, "fresh RunId");
  assert.equal(ws.allocated.length, 2, "each attempt allocated its OWN workspace");
});

test("session: NO EVIDENCE crosses the attempt boundary", async () => {
  const pub = scriptedPublisher(["stale", "land"]);
  const session = await executeV2BuildSession(build, baseDeps({ publisher: pub.target }));
  const [a, b] = session.attempts;
  assert.notEqual(a!.runId, b!.runId);
  // Distinct source snapshots ⇒ distinct candidate / verification / critic / disposition ids.
  assert.notEqual(a!.receipt.sourceSnapshot!.snapshotId, b!.receipt.sourceSnapshot!.snapshotId);
  assert.notEqual(a!.receipt.candidate!.candidateId, b!.receipt.candidate!.candidateId);
  assert.notEqual(a!.receipt.verification!.verificationId, b!.receipt.verification!.verificationId);
  assert.notEqual(a!.receipt.critic!.criticId, b!.receipt.critic!.criticId);
  assert.notEqual(a!.receipt.disposition!.dispositionId, b!.receipt.disposition!.dispositionId);
  // The ledger references each attempt's own ids, in order.
  assert.equal(session.ledger[0]!.runId, a!.runId);
  assert.equal(session.ledger[1]!.runId, b!.runId);
});

test("session: a CAS CONFLICT is auto-retried by a fresh attempt (no force in promotion)", async () => {
  const pub = scriptedPublisher(["cas", "land"]);
  const session = await executeV2BuildSession(build, baseDeps({ publisher: pub.target }));
  assert.equal(session.attempts.length, 2);
  assert.equal(session.recoveryDecisions[0]!.trigger, "target_moved", "a CAS conflict presents as a moved target");
  assert.equal(session.outcome.kind, "accepted");
});

test("session: a VERIFICATION TIMEOUT is auto-retried", async () => {
  let call = 0;
  const checkRunner = { run: async () => { call += 1; return call === 1 ? { ...CHECK_PASS, timedOut: true, exitCode: 124 } : CHECK_PASS; } };
  const session = await executeV2BuildSession(build, baseDeps({ checkRunner }));
  assert.equal(session.attempts[0]!.receipt.verification!.verdict, "timeout");
  assert.equal(session.recoveryDecisions[0]!.trigger, "verification_timeout");
  assert.equal(session.recoveryDecisions[0]!.kind, "retry_fresh_attempt");
  assert.equal(session.outcome.kind, "accepted");
});

test("session: a TRANSIENT provider failure is auto-retried — invocation stays single-shot", async () => {
  let call = 0;
  const transport: InvocationTransport = {
    send: async (input) => {
      call += 1;
      // The FIRST attempt's builder call fails transiently; every later call succeeds.
      if (call === 1) return { ok: false, failure: { code: "invocation.transport_failure", message: "connection reset", providerId: "alpha", attempts: 1 } } as never;
      const ok = okTransport();
      return ok.send(input);
    },
  };
  const session = await executeV2BuildSession(build, baseDeps({ transport }));
  assert.equal(session.attempts[0]!.outcome.kind, "failed");
  assert.equal(session.attempts[0]!.receipt.evidence.invocations, 1, "the invocation authority made ONE attempt — no application retry");
  assert.equal(session.recoveryDecisions[0]!.trigger, "provider_transient");
  assert.equal(session.recoveryDecisions[0]!.kind, "retry_fresh_attempt");
  assert.equal(session.outcome.kind, "accepted", "recovery — not the transport — created the second attempt");
});

// ── adverse judgments are NEVER retried ───────────────────────────────────────

test("session: a CRITIC DEFECT is NOT retried (no critic-fix loop)", async () => {
  const transport: InvocationTransport = {
    send: async (input) => {
      const isCritic = !input.messages.some((m) => m.role === "tool") && input.messages.some((m) => m.content.includes("critic"));
      if (isCritic) return { ok: true, response: { content: JSON.stringify({ verdict: "defects_found", summary: "wrong", defects: [{ category: "wrong_behavior", severity: "major", description: "it does the wrong thing", paths: ["a"] }] }), finishReason: "stop", attempts: 1, servedModelId: input.providerModelId } } as never;
      return okTransport().send(input);
    },
  };
  const session = await executeV2BuildSession(build, baseDeps({ transport }));
  assert.equal(session.attempts.length, 1, "no retry — a defect is a completed judgment");
  assert.equal(session.outcome.kind, "withheld");
  assert.equal(session.recoveryDecisions[0]!.kind, "stop_withheld");
});

test("session: a VERIFICATION FAIL is NOT retried (no semantic repair)", async () => {
  const checkRunner = { run: async () => ({ ...CHECK_PASS, exitCode: 1 }) };
  const session = await executeV2BuildSession(build, baseDeps({ checkRunner }));
  assert.equal(session.attempts.length, 1);
  assert.equal(session.attempts[0]!.receipt.verification!.verdict, "fail");
  assert.equal(session.outcome.kind, "rejected");
  assert.equal(session.recoveryDecisions[0]!.kind, "stop_rejected");
});

// ── operator-required + budget + degraded ─────────────────────────────────────

test("session: a DIRTY source requires an operator — no endless recapture", async () => {
  const dirtySources: SourceSnapshotAuthority = {
    capture: async () => ({ ok: true, reader: { snapshot: { snapshotId: ("d".repeat(64)) as never, repositoryRoot: "/repo", headCommit: "c".repeat(40), headTree: "t".repeat(40), clean: false, policy: {} as never, entries: [], exclusions: [], counts: {} as never, capturedAt: 1 }, read: async () => undefined } as never }),
  };
  const session = await executeV2BuildSession(build, baseDeps({ sources: dirtySources }));
  assert.equal(session.attempts.length, 1, "a fresh attempt over the same dirt changes nothing");
  assert.equal(session.outcome.kind, "withheld");
  assert.equal(session.recoveryDecisions[0]!.kind, "require_operator");
});

test("session: the retry BUDGET is bounded — no attempt 3", async () => {
  // A publisher that is stale on EVERY attempt: recovery retries once, then the budget is spent.
  const pub = scriptedPublisher(["stale", "stale", "stale"]);
  const session = await executeV2BuildSession(build, baseDeps({ publisher: pub.target, recoveryPolicy: buildRecoveryPolicy({ maxAttempts: 2 }) }));
  assert.equal(session.attempts.length, 2, "exactly maxAttempts — never a third");
  assert.equal(session.recoveryDecisions[0]!.kind, "retry_fresh_attempt");
  assert.equal(session.recoveryDecisions[1]!.kind, "require_operator");
  assert.equal(session.recoveryDecisions[1]!.reason, "retry_budget_exhausted");
});

test("session: a DEGRADED landing is reconciliation — NEVER a re-publish", async () => {
  const pub = scriptedPublisher(["degraded"]);
  const session = await executeV2BuildSession(build, baseDeps({ publisher: pub.target }));
  assert.equal(session.attempts.length, 1, "the ref already moved — no second attempt");
  assert.equal(session.outcome.kind, "accepted", "the candidate tree is authoritative");
  assert.equal(session.recoveryDecisions[0]!.kind, "reconciliation_required");
  assert.equal(session.receipt.reconciliationRequired, true);
  assert.deepEqual(pub.publishCalls.length, 1, "publish was attempted exactly once");
});

// ── policy freeze + receipt ───────────────────────────────────────────────────

test("session: configuration is FROZEN — loaded once, never reread between attempts", async () => {
  let loads = 0;
  const counting: ConfigurationSource = { load: async (req) => { loads += 1; return workingConfiguration.load(req); } };
  const pub = scriptedPublisher(["stale", "land"]);
  await executeV2BuildSession(build, baseDeps({ configuration: counting, publisher: pub.target }));
  assert.equal(loads, 1, "the two attempts shared ONE frozen configuration");
});

test("session: the receipt keeps per-attempt attribution and a truthful final outcome", async () => {
  const pub = scriptedPublisher(["stale", "land"]);
  const session = await executeV2BuildSession(build, baseDeps({ publisher: pub.target }));
  const r = session.receipt;
  assert.equal(r.totalAttempts, 2);
  assert.equal(r.attempts.length, 2, "each attempt is retained, not flattened away");
  assert.equal(r.recoveryDecisions.length, 2);
  assert.equal(r.finalAttemptRunId, session.attempts[1]!.runId);
  assert.equal(r.finalOutcome.kind, "accepted");
  assert.equal(r.totalInvocations, session.attempts.reduce((n, a) => n + a.receipt.evidence.invocations, 0), "aggregate = sum of attempts");
});

test("session: a single clean attempt is one attempt, accepted, no recovery churn", async () => {
  const session = await executeV2BuildSession(build, baseDeps());
  assert.equal(session.attempts.length, 1);
  assert.equal(session.outcome.kind, "accepted");
  assert.equal(session.recoveryDecisions[0]!.kind, "stop_accepted");
  assert.equal(session.recoveryDecisions[0]!.authorizesNewAttempt, false);
});
