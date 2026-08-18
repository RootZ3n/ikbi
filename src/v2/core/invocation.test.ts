/**
 * THE INVOCATION AUTHORITY — unit coverage.
 *
 * The load-bearing assertions are about the four identities staying apart, about the
 * authority never looking for an alternative route, and about "served" never being
 * fabricated from "sent".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextPackage } from "./context.js";
import { assembleContext } from "./context.js";
import type { ModelCapabilityFacts } from "./config.js";
import { createSequentialIdFactory } from "./identity.js";
import {
  V2_INVOCATION_FAILURE_CODES,
  V2_SERVED_MODEL_ALIASES,
  classifyServedIdentity,
  invocationRequestDigest,
  invokeAuthorized,
  type InvocationAuthorityInput,
  type InvocationTransport,
  type ServedModelAlias,
} from "./invocation.js";
import { QUALIFICATION_SYSTEM_INSTRUCTION, renderModelInput } from "./prompt.js";
import type { ModelResolutionDecision } from "./resolver.js";

import { DEFAULT_SOURCE_POLICY, type SourceSnapshot, type SourceSnapshotReader } from "./source.js";

/** A snapshot reader serving nothing — this suite injects no repository artifacts. */
function snapshotReader(): SourceSnapshotReader {
  const snapshot = {
    snapshotId: "s".repeat(64) as SourceSnapshot["snapshotId"],
    repositoryRoot: "/repo",
    headCommit: "c".repeat(40),
    headTree: "t".repeat(40),
    clean: true,
    policy: DEFAULT_SOURCE_POLICY,
    entries: [],
    exclusions: [],
    counts: { modified: 0, deleted: 0, untrackedIncluded: 0, excluded: 0 },
    capturedAt: 1,
  } satisfies SourceSnapshot;
  return { snapshot, list: async () => [], read: async () => ({ ok: false, reason: "missing", detail: "not in this snapshot" }) };
}

const ids = createSequentialIdFactory("inv");
const RUN = ids.mint("run");
const TASK = ids.mint("task");

const CAPS: ModelCapabilityFacts = {
  contextWindow: 100_000,
  supportsTools: true,
  reasoningLevel: "medium",
  speedClass: "medium",
  provenance: "declared",
};

function decision(over: Partial<ModelResolutionDecision> = {}): ModelResolutionDecision {
  return {
    decisionId: "d".repeat(64) as ModelResolutionDecision["decisionId"],
    runId: RUN,
    policyId: "p".repeat(64) as ModelResolutionDecision["policyId"],
    role: "builder",
    modelId: "alpha",
    providerId: "p1",
    providerModelId: "alpha-v1",
    routeOrdinal: 0,
    routeCount: 1,
    preferenceSource: "active_profile",
    providerConstraint: "explicit",
    providerReadiness: "keyless",
    providerKind: "openai-compatible",
    baseUrl: "https://p1.test/v1",
    basis: "explicit_provider_constraint",
    requirements: { requiresTools: false, requiresThinking: false, minContextWindow: 0 },
    capabilities: CAPS,
    ...over,
  } as ModelResolutionDecision;
}

async function contextPackage(over: { runId?: typeof RUN; taskId?: typeof TASK; decisionId?: string } = {}): Promise<ContextPackage> {
  const result = await assembleContext(
    {
      runId: over.runId ?? RUN,
      taskId: over.taskId ?? TASK,
      goal: "make the widget green",
      source: snapshotReader(),
      resolutionDecisionId: (over.decisionId ?? "d".repeat(64)) as ModelResolutionDecision["decisionId"],
      capabilities: CAPS,
    },
    [],
  );
  assert.ok(result.ok);
  return result.package;
}

/** A transport that records what it was sent and answers as configured. */
function transportOf(over: { servedModelId?: string | null; attempts?: number } = {}) {
  const sent: { providerId: string; providerModelId: string; messages: readonly { role: string; content: string }[] }[] = [];
  const transport: InvocationTransport = {
    send: async (input) => {
      sent.push({ providerId: input.providerId, providerModelId: input.providerModelId, messages: input.messages });
      return {
        ok: true,
        response: {
          content: "acknowledged",
          finishReason: "stop",
          ...(over.servedModelId === null ? {} : { servedModelId: over.servedModelId ?? input.providerModelId }),
          usage: { promptTokens: 42, completionTokens: 7, totalTokens: 49 },
          attempts: over.attempts ?? 1,
        },
      };
    },
  };
  return { transport, sent };
}

async function invoke(over: Partial<InvocationAuthorityInput> = {}, transport?: InvocationTransport) {
  return invokeAuthorized({
    runId: RUN,
    taskId: TASK,
    invocationId: ids.mint("invocation"),
    decision: decision(),
    contextPackage: await contextPackage(),
    parameters: { maxOutputTokens: 128, timeoutMs: 1_000 },
    transport: transport ?? transportOf().transport,
    now: () => 1_000,
    ...over,
  });
}

// ── the authorized route, and only it ───────────────────────────────────────

test("invocation: sends EXACTLY the authorized provider and wire model, once", async () => {
  const t = transportOf();
  const result = await invoke({}, t.transport);
  assert.ok(result.ok);
  assert.equal(t.sent.length, 1, "one outbound attempt");
  assert.equal(t.sent[0]?.providerId, "p1");
  assert.equal(t.sent[0]?.providerModelId, "alpha-v1");
  assert.equal(result.record.attempts, 1);
});

test("invocation: the four identities are recorded separately", async () => {
  const result = await invoke();
  assert.ok(result.ok);
  const id = result.record.identity;
  assert.equal(id.requestedRole, "builder");
  assert.equal(id.requestedModelId, "alpha", "the LOGICAL model policy preferred");
  assert.equal(id.authorizedProviderModelId, "alpha-v1");
  assert.equal(id.sentProviderModelId, "alpha-v1", "what actually went on the wire");
  assert.equal(id.servedModelId, "alpha-v1", "what the provider says served it");
  assert.equal(id.identityStatus, "match");
});

test("invocation: the record binds the decision and the context package", async () => {
  const pkg = await contextPackage();
  const result = await invoke({ contextPackage: pkg });
  assert.ok(result.ok);
  assert.equal(result.record.resolutionDecisionId, decision().decisionId);
  assert.equal(result.record.contextPackageId, pkg.packageId);
  assert.equal(result.record.runId, RUN);
  assert.equal(result.record.taskId, TASK);
});

test("invocation: the record is frozen", async () => {
  const result = await invoke();
  assert.ok(result.ok);
  assert.ok(Object.isFrozen(result.record));
  assert.ok(Object.isFrozen(result.record.identity));
  assert.throws(() => {
    (result.record as { attempts: number }).attempts = 99;
  }, TypeError);
});

// ── binding ─────────────────────────────────────────────────────────────────

test("invocation: a context package from a DIFFERENT run is refused, not repaired", async () => {
  const otherRun = ids.mint("run");
  const result = await invoke({ contextPackage: await contextPackage({ runId: otherRun }) });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_INVOCATION_FAILURE_CODES.bindingMismatch);
  assert.equal(result.attempted, false, "nothing reached the wire");
});

test("invocation: context sized by a DIFFERENT decision is refused", async () => {
  const result = await invoke({ contextPackage: await contextPackage({ decisionId: "e".repeat(64) }) });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_INVOCATION_FAILURE_CODES.bindingMismatch);
  assert.match(result.failure.message, /sized by decision/);
});

test("invocation: a decision from a different run is refused", async () => {
  const result = await invoke({ decision: decision({ runId: ids.mint("run") }) });
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_INVOCATION_FAILURE_CODES.bindingMismatch);
});

test("invocation: a binding failure never touches the transport", async () => {
  const t = transportOf();
  await invoke({ contextPackage: await contextPackage({ runId: ids.mint("run") }) }, t.transport);
  assert.equal(t.sent.length, 0, "binding is checked before anything leaves the process");
});

// ── served identity ─────────────────────────────────────────────────────────

test("identity: an exact report is a MATCH", () => {
  assert.equal(classifyServedIdentity("p1", "alpha-v1", "alpha-v1", []), "match");
});

test("identity: a DECLARED alias is an ALIASED_MATCH; an undeclared one is a MISMATCH", () => {
  const aliases: readonly ServedModelAlias[] = [
    { providerId: "p1", sent: "alpha-v1", served: "alpha-v1-20260801", note: "observed in a fixture" },
  ];
  assert.equal(classifyServedIdentity("p1", "alpha-v1", "alpha-v1-20260801", aliases), "aliased_match");
  assert.equal(classifyServedIdentity("p1", "alpha-v1", "alpha-v1-20260901", aliases), "mismatch", "a different date is not declared");
  assert.equal(classifyServedIdentity("p2", "alpha-v1", "alpha-v1-20260801", aliases), "mismatch", "declared for a different provider");
});

test("identity: nothing is inferred from shape — no prefix, substring or 'close enough'", () => {
  for (const served of ["alpha-v1-turbo", "alpha", "alpha-v2", "ALPHA-V1", " alpha-v1"]) {
    assert.equal(classifyServedIdentity("p1", "alpha-v1", served, []), "mismatch", `${served} is not silently accepted`);
  }
});

test("identity: an absent report is NOT_REPORTED and is never filled in", async () => {
  const result = await invoke({}, transportOf({ servedModelId: null }).transport);
  assert.ok(result.ok);
  assert.equal(result.record.identity.identityStatus, "not_reported");
  assert.equal(result.record.identity.servedModelId, undefined, "never fabricated from what was sent");
  assert.equal(classifyServedIdentity("p1", "alpha-v1", "", []), "not_reported", "an empty string is also no report");
});

test("identity: a MISMATCH fails the invocation and preserves all three facts", async () => {
  const result = await invoke({}, transportOf({ servedModelId: "beta-v9" }).transport);
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_INVOCATION_FAILURE_CODES.servedIdentityMismatch);
  assert.equal(result.attempted, true, "the provider WAS contacted");
  assert.equal(result.failure.detail?.authorizedModelId, "alpha");
  assert.equal(result.failure.detail?.sentProviderModelId, "alpha-v1");
  assert.equal(result.failure.detail?.servedModelId, "beta-v9");
});

test("identity: the production alias table is empty — an unexplained difference is a mismatch", () => {
  assert.deepEqual([...V2_SERVED_MODEL_ALIASES], [], "no alias is asserted without having been observed");
});

// ── retry ───────────────────────────────────────────────────────────────────

test("retry: a transport reporting more than one attempt is a LOUD failure", async () => {
  const result = await invoke({}, transportOf({ attempts: 3 }).transport);
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_INVOCATION_FAILURE_CODES.unexpectedRetry);
  assert.equal(result.failure.detail?.attempts, 3);
});

test("retry: a transport failure is returned, never retried", async () => {
  let calls = 0;
  const flaky: InvocationTransport = {
    send: async () => {
      calls += 1;
      return { ok: false, failure: { code: V2_INVOCATION_FAILURE_CODES.transportFailure, message: "connection reset", providerId: "p1", attempts: 1 } };
    },
  };
  const result = await invoke({}, flaky);
  assert.ok(!result.ok);
  assert.equal(calls, 1, "one attempt; recovery belongs to a controller that does not exist yet");
  assert.equal(result.attempted, true);
});

test("retry: a pre-wire failure is NOT counted as an attempt", async () => {
  const unavailable: InvocationTransport = {
    send: async () => ({ ok: false, failure: { code: V2_INVOCATION_FAILURE_CODES.providerNotAvailable, message: "no such provider", providerId: "p1", attempts: 0 } }),
  };
  const result = await invoke({}, unavailable);
  assert.ok(!result.ok);
  assert.equal(result.attempted, false, "intention is not an invocation");
});

// ── usage ───────────────────────────────────────────────────────────────────

test("usage: only what the provider reported is carried, and it is not estimated", async () => {
  const result = await invoke();
  assert.ok(result.ok);
  assert.deepEqual(result.record.usage, { promptTokens: 42, completionTokens: 7, totalTokens: 49 });
});

test("usage: a provider that reports nothing yields no usage block", async () => {
  const silent: InvocationTransport = {
    send: async (input) => ({ ok: true, response: { content: "ok", finishReason: "stop", servedModelId: input.providerModelId, attempts: 1 } }),
  };
  const result = await invoke({}, silent);
  assert.ok(result.ok);
  assert.equal(result.record.usage, undefined, "absence is recorded as absence, not as zeroes");
});

// ── prompt ──────────────────────────────────────────────────────────────────

test("prompt: the model input comes only from the authorized context package", async () => {
  const pkg = await contextPackage();
  const rendered = renderModelInput(pkg);
  assert.equal(rendered.messages[0]?.role, "system");
  assert.equal(rendered.messages[0]?.content, QUALIFICATION_SYSTEM_INSTRUCTION);
  assert.match(rendered.messages[1]?.content ?? "", /make the widget green/, "the goal artifact");
  assert.match(rendered.messages[1]?.content ?? "", /sha256:/, "each block names the state it came from");
});

test("prompt: the qualification instruction forbids proposing or performing work", () => {
  assert.match(QUALIFICATION_SYSTEM_INSTRUCTION, /Do NOT propose changes/);
  assert.match(QUALIFICATION_SYSTEM_INSTRUCTION, /Do NOT execute anything/);
});

test("prompt: identical packages render an identical prompt id", async () => {
  assert.equal(renderModelInput(await contextPackage()).promptId, renderModelInput(await contextPackage()).promptId);
});

test("prompt: the rendered prompt reaches the transport verbatim", async () => {
  const pkg = await contextPackage();
  const t = transportOf();
  const result = await invoke({ contextPackage: pkg }, t.transport);
  assert.ok(result.ok);
  assert.deepEqual(t.sent[0]?.messages, renderModelInput(pkg).messages);
  assert.equal(result.record.promptId, renderModelInput(pkg).promptId);
});

// ── request identity ────────────────────────────────────────────────────────

test("request identity: the same semantic request digests the same", async () => {
  const pkg = await contextPackage();
  const base = {
    invocationId: ids.mint("invocation"),
    runId: RUN,
    taskId: TASK,
    role: "builder" as const,
    resolutionDecisionId: decision().decisionId,
    contextPackageId: pkg.packageId,
    authorizedModelId: "alpha",
    authorizedProviderId: "p1",
    authorizedProviderModelId: "alpha-v1",
    sentProviderId: "p1",
    sentProviderModelId: "alpha-v1",
    promptId: renderModelInput(pkg).promptId,
    parameters: { maxOutputTokens: 128, timeoutMs: 1_000 },
  };
  // A different invocation id is a different ATTEMPT of the same request.
  assert.equal(invocationRequestDigest(base), invocationRequestDigest({ ...base, invocationId: ids.mint("invocation") }));
  assert.notEqual(invocationRequestDigest(base), invocationRequestDigest({ ...base, sentProviderModelId: "alpha-v2" }));
});
