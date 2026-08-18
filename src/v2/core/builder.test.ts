/**
 * THE BUILDER CONTROLLER — the loop, the budget, and the finish contract.
 *
 * A scripted fake transport and a fake executor stand in for the provider and the
 * workspace, so these tests pin the CONTROLLER's behaviour exactly: what it sends, what it
 * accepts as finished, what it refuses to accept, and what it does when a tool fails.
 *
 * The end-to-end proof — a real socket, a real worktree, real compare-and-swap — is
 * `src/v2/cli/builder-truth.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BUILDER_BUDGET, generateCandidate, type BuilderToolExecutor } from "./builder.js";
import { BUILDER_SYSTEM_INSTRUCTION } from "./prompt.js";
import { V2_BUILD_FAILURE_CODES } from "./candidate.js";
import { TOOL_FINISH_CANDIDATE, TOOL_READ_FILE, TOOL_REPLACE_FILE, type ToolOutcome } from "./tools.js";
import type { InvocationTransport, TransportOutcome } from "./invocation.js";
import type { ContextPackage } from "./context.js";
import type { ModelResolutionDecision } from "./resolver.js";
import type { V2ContextDigest, V2DecisionDigest, V2InvocationId, V2MutationDigest, V2RunId, V2TaskId } from "./identity.js";

const RUN = "run_test" as V2RunId;
const TASK = "task_test" as V2TaskId;
const DECISION_ID = "1".repeat(64) as V2DecisionDigest;
const PACKAGE_ID = "2".repeat(64) as V2ContextDigest;

const decision = {
  decisionId: DECISION_ID,
  runId: RUN,
  role: "builder",
  modelId: "m1",
  providerId: "p1",
  providerModelId: "m1-wire",
  capabilities: { contextWindowTokens: 100_000, supportsTools: true, provenance: "declared" },
} as unknown as ModelResolutionDecision;

const contextPackage = {
  packageId: PACKAGE_ID,
  runId: RUN,
  taskId: TASK,
  resolutionDecisionId: DECISION_ID,
  artifacts: [{ category: "task", sourceId: "task", origin: "operator", content: "change the widget", observedSha256: "a", bytes: 3, originalBytes: 3, truncated: false, estimatedTokens: 4, reason: "goal", artifactId: "x" }],
  omissions: [],
  sourcesConsulted: ["task"],
  budget: { availableInputTokens: 90_000, reservedCompletionTokens: 4_096, contextWindowTokens: 100_000, estimated: true, accounting: "estimated_chars_per_token", charsPerToken: 4 },
  estimatedInputTokens: 4,
  sourceSnapshotId: "3".repeat(64),
} as unknown as ContextPackage;

/** One scripted turn: what the "model" answers. */
interface Turn {
  readonly content?: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
}

/** A transport that answers a fixed script and records exactly what it was sent. */
function scriptedTransport(turns: readonly Turn[]) {
  const sent: { messages: readonly { role: string; content: string; toolCallId?: string }[]; toolNames: readonly string[] }[] = [];
  const transport: InvocationTransport = {
    async send(input): Promise<TransportOutcome> {
      sent.push({
        messages: input.messages.map((m) => ({ role: m.role, content: m.content, ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}) })),
        toolNames: (input.tools ?? []).map((t) => t.name),
      });
      const turn = turns[sent.length - 1];
      if (turn === undefined) return { ok: true, response: { content: "", finishReason: "stop", attempts: 1, servedModelId: "m1-wire" } };
      return {
        ok: true,
        response: {
          content: turn.content ?? "",
          finishReason: turn.toolCalls !== undefined && turn.toolCalls.length > 0 ? "tool_calls" : "stop",
          ...(turn.toolCalls !== undefined ? { toolCalls: turn.toolCalls } : {}),
          attempts: 1,
          servedModelId: "m1-wire",
        },
      };
    },
  };
  return { transport, sent };
}

/** An executor that answers a fixed script of outcomes, and records what it was asked. */
function scriptedExecutor(outcomes: readonly ToolOutcome[]) {
  const seen: string[] = [];
  let index = 0;
  const executor: BuilderToolExecutor = {
    async execute(call) {
      seen.push(call.name);
      const outcome = outcomes[index++] ?? { kind: "refused", path: "?", code: "test.exhausted", detail: "script exhausted" };
      return {
        outcome,
        ...(outcome.kind === "applied" ? { mutation: { mutationId: outcome.mutationId as V2MutationDigest, path: outcome.path } } : {}),
      };
    },
  };
  return { executor, seen };
}

let idSeq = 0;
const run = (turns: readonly Turn[], outcomes: readonly ToolOutcome[], budget = DEFAULT_BUILDER_BUDGET) => {
  const t = scriptedTransport(turns);
  const e = scriptedExecutor(outcomes);
  return generateCandidate({
    runId: RUN,
    taskId: TASK,
    decision,
    contextPackage,
    transport: t.transport,
    executor: e.executor,
    mintInvocationId: () => `inv_${(idSeq += 1)}` as V2InvocationId,
    budget,
    now: () => 1000,
  }).then((result) => ({ result, sent: t.sent, seen: e.seen }));
};

const finishCall = (id = "f1") => ({ id, name: TOOL_FINISH_CANDIDATE, arguments: JSON.stringify({ summary: "changed the widget", believesComplete: true }) });
const readCall = (id = "r1", path = "src/a.ts") => ({ id, name: TOOL_READ_FILE, arguments: JSON.stringify({ path }) });
const replaceCall = (id = "w1") => ({ id, name: TOOL_REPLACE_FILE, arguments: JSON.stringify({ path: "src/a.ts", observationId: "o1", content: "new" }) });

const observed: ToolOutcome = { kind: "observed", path: "src/a.ts", observationId: "o1", state: "regular", contentSha256: "aaa", byteLength: 3, content: "old" };
const applied: ToolOutcome = { kind: "applied", path: "src/a.ts", operation: "replace_file", mutationId: "m1", changed: true, beforeSha256: "aaa", afterSha256: "bbb" };
const stale: ToolOutcome = { kind: "refused", path: "src/a.ts", code: "mutation.stale_observation", detail: "changed since you read it", expectedSha256: "aaa", actualSha256: "ccc" };

// ── the happy path ──────────────────────────────────────────────────────────

test("builder: read → replace → finish produces a generation with one mutation", async () => {
  const { result } = await run(
    [{ toolCalls: [readCall()] }, { toolCalls: [replaceCall()] }, { toolCalls: [finishCall()] }],
    [observed, applied],
  );
  assert.ok(result.ok, result.ok ? "" : result.failure.message);
  assert.equal(result.generation.turns, 3);
  assert.equal(result.generation.toolCalls, 3);
  assert.equal(result.generation.toolFailures, 0);
  assert.deepEqual([...result.generation.mutationIds], ["m1"]);
  assert.deepEqual([...result.generation.changedPaths], ["src/a.ts"]);
  assert.equal(result.generation.claim.believesComplete, true);
  assert.equal(result.generation.claim.summary, "changed the widget");
});

test("builder: EVERY turn is one invocation, and they are all recorded", async () => {
  const { result } = await run(
    [{ toolCalls: [readCall()] }, { toolCalls: [replaceCall()] }, { toolCalls: [finishCall()] }],
    [observed, applied],
  );
  assert.ok(result.ok);
  assert.equal(result.generation.invocations.length, 3, "three turns, three invocations");
  assert.equal(new Set(result.generation.invocationIds).size, 3, "each turn gets a FRESH invocation id");
});

test("builder: every turn offers the SAME tools and uses the SAME authorized route", async () => {
  const { result, sent } = await run([{ toolCalls: [readCall()] }, { toolCalls: [finishCall()] }], [observed]);
  assert.ok(result.ok);
  for (const turn of sent) {
    assert.deepEqual([...turn.toolNames], ["read_file", "replace_file", "create_file", "delete_file", "finish_candidate"]);
  }
  const routes = new Set(result.generation.invocations.map((i) => `${i.identity.sentProviderId}/${i.identity.sentProviderModelId}`));
  assert.deepEqual([...routes], ["p1/m1-wire"], "no fallback, no second route, no escalation");
});

// ── the conversation ────────────────────────────────────────────────────────

test("builder: the standing contract and the authorized context lead every turn", async () => {
  const { sent } = await run([{ toolCalls: [finishCall()] }], []);
  assert.equal(sent[0]!.messages[0]!.role, "system");
  assert.equal(sent[0]!.messages[0]!.content, BUILDER_SYSTEM_INSTRUCTION);
  assert.equal(sent[0]!.messages[1]!.role, "user");
  assert.match(sent[0]!.messages[1]!.content, /change the widget/);
});

test("builder: a tool result is bound to the CALL it answers, and grows the conversation", async () => {
  const { sent } = await run([{ toolCalls: [readCall("r1")] }, { toolCalls: [finishCall()] }], [observed]);
  const second = sent[1]!.messages;
  const toolMessage = second.find((m) => m.role === "tool");
  assert.ok(toolMessage !== undefined, "the result went back on the wire");
  assert.equal(toolMessage.toolCallId, "r1", "bound to the call that produced it");
  assert.match(toolMessage.content, /observationId: o1/);
  assert.ok(second.some((m) => m.role === "assistant"), "and the model's own turn went back too");
});

test("builder: context is assembled ONCE — later turns re-send it, never re-derive it", async () => {
  const { sent } = await run([{ toolCalls: [readCall()] }, { toolCalls: [finishCall()] }], [observed]);
  assert.equal(sent[0]!.messages[1]!.content, sent[1]!.messages[1]!.content, "the same authorized package, byte for byte");
});

// ── the finish contract ─────────────────────────────────────────────────────

test("builder: a model that STOPS without finishing is nudged, not accepted", async () => {
  const { result, sent } = await run(
    [{ content: "I think that's everything." }, { toolCalls: [finishCall()] }],
    [],
  );
  assert.ok(result.ok, "the nudge worked and the model then finished");
  const nudge = sent[1]!.messages.find((m) => m.role === "user" && m.content.includes("without calling finish_candidate"));
  assert.ok(nudge !== undefined, "the model was told prose is not a finish");
});

test("builder: a model that NEVER finishes fails — a green-looking stop is not a candidate", async () => {
  const { result } = await run([{ content: "done!" }, { content: "really done!" }], [], { ...DEFAULT_BUILDER_BUDGET, maxTurns: 2 });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_BUILD_FAILURE_CODES.turnLimitExceeded);
  assert.equal(result.failure.category, "build");
  assert.equal(result.invocations.length, 2, "the turns it really took are still counted");
});

test("builder: work QUEUED AFTER finish_candidate in the same round is not executed", async () => {
  const { result, seen } = await run(
    [{ toolCalls: [finishCall("f1"), readCall("r9")] }],
    [observed],
  );
  assert.ok(result.ok);
  assert.deepEqual(seen, [], "nothing after the declaration reached the executor");
  assert.equal(result.generation.toolCalls, 1);
});

test("builder: finishing with ZERO mutations is a legitimate candidate", async () => {
  // Some tasks genuinely need no edit. Failing "no diff" automatically would make the
  // builder decide a question that belongs to verification.
  const { result } = await run([{ toolCalls: [readCall()] }, { toolCalls: [finishCall()] }], [observed]);
  assert.ok(result.ok);
  assert.deepEqual([...result.generation.mutationIds], []);
  assert.deepEqual([...result.generation.changedPaths], []);
  assert.equal(result.generation.claim.believesComplete, true);
});

// ── failure and refusal ─────────────────────────────────────────────────────

test("builder: a STALE write is reported to the model, and NOTHING is retried", async () => {
  const { result, seen } = await run(
    [{ toolCalls: [readCall()] }, { toolCalls: [replaceCall()] }, { toolCalls: [finishCall()] }],
    [observed, stale],
  );
  assert.ok(result.ok);
  assert.deepEqual(seen, ["read_file", "replace_file"], "the controller did NOT re-read and re-apply on its own");
  assert.equal(result.generation.toolFailures, 1);
  assert.deepEqual([...result.generation.mutationIds], [], "and nothing was recorded as applied");
});

test("builder: the model is told exactly what the refusal was", async () => {
  const { sent } = await run(
    [{ toolCalls: [readCall()] }, { toolCalls: [replaceCall("w1")] }, { toolCalls: [finishCall()] }],
    [observed, stale],
  );
  const result = sent[2]!.messages.filter((m) => m.role === "tool").at(-1)!;
  assert.equal(result.toolCallId, "w1");
  assert.match(result.content, /REFUSED/);
  assert.match(result.content, /expected sha256: aaa/);
  assert.match(result.content, /actual sha256: ccc/);
});

test("builder: a MALFORMED tool call is a tool failure, not a crash", async () => {
  const { result, seen } = await run(
    [{ toolCalls: [{ id: "b1", name: TOOL_REPLACE_FILE, arguments: "{bad" }] }, { toolCalls: [finishCall()] }],
    [],
  );
  assert.ok(result.ok, "the loop survived and the model finished");
  assert.deepEqual(seen, [], "a call that could not be parsed never reached the executor");
  assert.equal(result.generation.toolFailures, 1);
});

test("builder: an UNKNOWN tool name is refused without reaching the executor", async () => {
  const { result, seen } = await run(
    [{ toolCalls: [{ id: "b1", name: "terminal", arguments: JSON.stringify({ command: "rm -rf /" }) }] }, { toolCalls: [finishCall()] }],
    [],
  );
  assert.ok(result.ok);
  assert.deepEqual(seen, []);
  assert.equal(result.generation.toolFailures, 1);
});

test("builder: a TRANSPORT failure ends generation — no fallback, no second route", async () => {
  const transport: InvocationTransport = {
    async send() {
      return { ok: false, failure: { code: "invocation.transport_failure", message: "socket died", providerId: "p1", attempts: 1 } };
    },
  };
  const result = await generateCandidate({
    runId: RUN,
    taskId: TASK,
    decision,
    contextPackage,
    transport,
    executor: scriptedExecutor([]).executor,
    mintInvocationId: () => `inv_x` as V2InvocationId,
    now: () => 1000,
  });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, "invocation.transport_failure");
  assert.deepEqual([...result.mutationIds], []);
});

// ── budgets ─────────────────────────────────────────────────────────────────

test("builder: the TURN budget is a hard stop that produces a failure, never a rescue", async () => {
  const turns = Array.from({ length: 10 }, () => ({ toolCalls: [readCall()] }));
  const { result } = await run(turns, Array.from({ length: 10 }, () => observed), { ...DEFAULT_BUILDER_BUDGET, maxTurns: 3 });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_BUILD_FAILURE_CODES.turnLimitExceeded);
  assert.equal(result.failure.detail?.["maxTurns"], 3);
});

test("builder: the TOOL-CALL budget is a hard stop", async () => {
  const { result } = await run(
    [{ toolCalls: [readCall("a"), readCall("b"), readCall("c")] }],
    [observed, observed, observed],
    { ...DEFAULT_BUILDER_BUDGET, maxToolCalls: 2 },
  );
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_BUILD_FAILURE_CODES.toolLimitExceeded);
});

test("builder: the MUTATION budget is a hard stop, and prior mutations are still reported", async () => {
  const { result } = await run(
    [{ toolCalls: [replaceCall("w1"), replaceCall("w2"), replaceCall("w3")] }],
    [applied, { ...applied, mutationId: "m2" } as ToolOutcome, { ...applied, mutationId: "m3" } as ToolOutcome],
    { ...DEFAULT_BUILDER_BUDGET, maxMutations: 2 },
  );
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_BUILD_FAILURE_CODES.mutationLimitExceeded);
  assert.equal(result.mutationIds.length, 3, "what really applied is reported, not erased by the failure");
});

test("builder: the completion cap never exceeds what the context budget reserved", async () => {
  const { result } = await run([{ toolCalls: [finishCall()] }], [], { ...DEFAULT_BUILDER_BUDGET, maxOutputTokens: 999_999 });
  assert.ok(result.ok);
  assert.equal(result.generation.invocations[0]!.parameters.maxOutputTokens, 4_096, "clamped to the reserved completion budget");
});
