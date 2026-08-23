/**
 * HOSTILE TESTS for the local-assist lane.
 *
 * `core/local-work.test.ts` proves the DECISIONS. This proves the lane that carries them out — that
 * OFF makes no request at all, that an admitted answer is still nothing until a deterministic
 * validator says otherwise, that a discarded answer is recorded as discarded, and that the local
 * model is never handed anything it could act with.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runLocalLane, type LocalLaneDeps, type LocalLaneRequest, type LocalPacketItem, type LocalValidator } from "./local-lane.js";
import type { UntrustedBoundary } from "../core/builder.js";
import type { AttestedLocalIdentity, InvocationTransport } from "../core/invocation.js";

const PACKET: readonly LocalPacketItem[] = [
  { id: "log:1", content: "FAIL src/widget.test.ts: expected 2, got 1\n", source: "tool_result" },
];

const BINDING: AttestedLocalIdentity = {
  modelId: "qwen3.5-35b-a3b.q2-k",
  artifactDigest: "sha256:4953",
  attested: true,
  qualificationStatus: "INSTALLED_UNQUALIFIED",
  qualificationAuthority: "none",
};

/** A validator that accepts anything containing "assertion". Deterministic; calls no model. */
const ACCEPTING: LocalValidator = {
  name: "triage",
  validate: (raw) => (raw.includes("assertion") ? { ok: true, artifact: { kind: "assertion_failure" } } : { ok: false, detail: "no classification found" }),
};

/** A validator that also checks citations. */
const CITING: LocalValidator = {
  name: "cited-triage",
  citations: (raw) => {
    const m = /QUOTE\[(.*?)\]\{(.*?)\}/s.exec(raw);
    return m === null ? [] : [{ sourceId: m[1]!, quote: m[2]! }];
  },
  validate: () => ({ ok: true, artifact: { cited: true } }),
};

/** A boundary that FENCES visibly, so a test can prove the raw bytes never travelled bare. */
const boundary: UntrustedBoundary = {
  wrap: (input) => `<<UNTRUSTED ${input.source}>>${input.content}<<END>>`,
} as UntrustedBoundary;

function req(over: Partial<LocalLaneRequest> = {}): LocalLaneRequest {
  return {
    mode: "assist", taskClass: "test_log_triage", instruction: "classify the failure",
    packet: PACKET, validator: ACCEPTING, requireQualified: false, requireAttestation: true, ...over,
  };
}

/**
 * A TRANSPORT that answers with `content`, or fails with a typed code. Records what it was sent.
 *
 * The lane calls a model exactly the way the builder does — through the one transport seam — so a
 * fake transport is the honest stand-in, not a fake provider.
 */
function transport(opts: { content?: string; failCode?: string; binding?: AttestedLocalIdentity | undefined; usage?: unknown; throws?: unknown } = {}) {
  const calls: { prompt: string; input: Record<string, unknown> }[] = [];
  const t: InvocationTransport = {
    send: async (input: unknown) => {
      const i = input as unknown as Record<string, unknown>;
      const messages = i["messages"] as { content: string }[];
      calls.push({ prompt: messages[0]!.content, input: i });
      if (opts.throws !== undefined) throw opts.throws;
      if (opts.failCode !== undefined) {
        return { ok: false, failure: { code: opts.failCode, message: `local said ${opts.failCode}`, providerId: "bokahli", attempts: 1 } };
      }
      return {
        ok: true,
        response: {
          content: opts.content ?? "assertion failure",
          ...("binding" in opts ? (opts.binding !== undefined ? { attestedIdentity: opts.binding } : {}) : { attestedIdentity: BINDING }),
          ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
          attempts: 1,
        },
      };
    },
  } as unknown as InvocationTransport;
  return { t, calls };
}

const deps = (over: Partial<LocalLaneDeps> = {}): LocalLaneDeps => ({
  boundary, sleep: async () => undefined, jitter: () => 0.5, ...over,
});

// ── OFF and absence ─────────────────────────────────────────────────────────

test("OFF makes ZERO requests to Bokahli — the provider is never touched", async () => {
  const { t, calls } = transport();
  const r = await runLocalLane(req({ mode: "off" }), deps({ transport: t }));
  assert.equal(r.accepted, false);
  assert.equal(r.decision.reason, "mode_off");
  assert.equal(calls.length, 0, "OFF must not produce a single outbound call");
  assert.deepEqual(r.attempts, []);
});

test("an absent provider is not an error — the lane declines and the caller carries on", async () => {
  const r = await runLocalLane(req({ mode: "auto" }), deps({}));
  assert.equal(r.accepted, false);
  assert.equal(r.decision.reason, "not_configured");
  assert.equal(r.attempts.length, 0);
});

test("an INELIGIBLE task never reaches Bokahli", async () => {
  const { t, calls } = transport();
  for (const taskClass of ["autonomous_publication", "credential_handling", "broad_refactor", "unbounded_repository_access"]) {
    const r = await runLocalLane(req({ mode: "auto", taskClass }), deps({ transport: t }));
    assert.equal(r.accepted, false);
    assert.equal(r.decision.reason, "task_class_ineligible");
  }
  assert.equal(calls.length, 0, "an ineligible task must produce no outbound call at all");
});

test("an oversized packet is refused before any request is made", async () => {
  const { t, calls } = transport();
  const huge = [{ id: "big", content: "x".repeat(2048), source: "repo" as const }];
  const r = await runLocalLane(req({ mode: "auto", packet: huge, packetByteCeiling: 1024 }), deps({ transport: t }));
  assert.equal(r.decision.reason, "packet_unbounded");
  assert.equal(calls.length, 0);
});

// ── the packet ──────────────────────────────────────────────────────────────

test("every byte of evidence is FENCED before it reaches the model", async () => {
  const { t, calls } = transport();
  await runLocalLane(req(), deps({ transport: t }));
  const prompt = calls[0]!.prompt;
  // A failing test's output is attacker-influenced in the same way a web page is.
  assert.match(prompt, /<<UNTRUSTED tool_result>>/);
  assert.match(prompt, /<<END>>/);
  assert.ok(!prompt.includes("FAIL src/widget.test.ts: expected 2, got 1\n\nTASK"), "raw bytes must not travel outside the fence");
});

test("the local model is told it has no tools, and is handed none", async () => {
  const { t, calls } = transport();
  await runLocalLane(req(), deps({ transport: t }));
  assert.match(calls[0]!.prompt, /no tools and no access/);
  // STRUCTURAL, not advisory: the transport's `tools` field is never populated, so the worker
  // cannot call a tool it was never offered. Saying so in the prompt is belt; this is braces.
  assert.equal(calls[0]!.input["tools"], undefined);
  assert.equal(calls[0]!.input["workspace"], undefined);
  assert.equal(calls[0]!.input["providerId"], "bokahli");
});

// ── admitted is not accepted ────────────────────────────────────────────────

test("an admitted answer the VALIDATOR rejects is not accepted, and is recorded as discarded", async () => {
  const { t } = transport({ content: "I think it is probably fine" });
  const r = await runLocalLane(req(), deps({ transport: t }));
  assert.equal(r.accepted, false);
  assert.equal(r.rejection, "validator_rejected");
  assert.match(r.detail, /triage: no classification found/);
  assert.equal(r.partialOutputDiscarded, true, "a validated-away answer IS discarded local output");
  assert.equal(r.artifact, undefined);
});

test("an accepted answer carries the validator's ARTIFACT, not the model's prose", async () => {
  const { t } = transport({ content: "assertion failure at line 1" });
  const r = await runLocalLane(req(), deps({ transport: t }));
  assert.equal(r.accepted, true);
  assert.deepEqual(r.artifact, { kind: "assertion_failure" });
});

test("an INVENTED citation is refused even when the validator would have accepted", async () => {
  const { t } = transport({ content: "QUOTE[log:1]{expected 3, got 1}" });
  const r = await runLocalLane(req({ validator: CITING }), deps({ transport: t }));
  assert.equal(r.accepted, false);
  assert.equal(r.rejection, "citation_unresolved");
  assert.match(r.detail, /unresolved citation/);
});

test("a citation that resolves EXACTLY against the packet is accepted", async () => {
  const { t } = transport({ content: "QUOTE[log:1]{expected 2, got 1}" });
  const r = await runLocalLane(req({ validator: CITING }), deps({ transport: t }));
  assert.equal(r.accepted, true);
});

// ── identity and qualification ──────────────────────────────────────────────

test("an accepted result records the EXACT artifact that served it", async () => {
  const { t } = transport();
  const r = await runLocalLane(req(), deps({ transport: t }));
  assert.deepEqual(r.servedIdentity, {
    modelId: "qwen3.5-35b-a3b.q2-k", artifactDigest: "sha256:4953", qualificationStatus: "INSTALLED_UNQUALIFIED",
  });
});

test("an unqualified result is stamped supervised — review required, promotion forbidden", async () => {
  const { t } = transport();
  const r = await runLocalLane(req(), deps({ transport: t }));
  assert.equal(r.supervision!.qualified, false);
  assert.equal(r.supervision!.humanReviewRequired, true);
  assert.equal(r.supervision!.autonomousPromotionAllowed, false);
});

test("requireQualified refuses rather than downgrading to supervised execution", async () => {
  const { t } = transport();
  const r = await runLocalLane(req({ requireQualified: true }), deps({ transport: t }));
  assert.equal(r.accepted, false);
  assert.equal(r.rejection, "unqualified_artifact");
  assert.equal(r.supervision, undefined);
});

test("a WRONG artifact is rejected, never silently substituted", async () => {
  const { t } = transport();
  const r = await runLocalLane(req({ expectedModelId: "gemma4-12b.q6-k" }), deps({ transport: t }));
  assert.equal(r.rejection, "identity_mismatch");
});

test("a wrong DIGEST is rejected even when the name matches", async () => {
  const { t } = transport();
  const r = await runLocalLane(req({ expectedModelId: BINDING.modelId, expectedDigest: "sha256:nope" }), deps({ transport: t }));
  assert.equal(r.rejection, "digest_mismatch");
});

test("an UNATTESTED result is rejected when attestation is required", async () => {
  const { t } = transport({ binding: undefined });
  const r = await runLocalLane(req({ requireAttestation: true }), deps({ transport: t }));
  assert.equal(r.accepted, false);
  assert.equal(r.rejection, "unattested_identity");
  assert.equal(r.partialOutputDiscarded, true, "text arrived and was thrown away — say so");
});

// ── refusals, protocol, retry ───────────────────────────────────────────────

test("a typed REFUSAL is a typed result, never an exception escaping the lane", async () => {
  const { t } = transport({ failCode: "NO_QUALIFIED_WORKER" });
  const r = await runLocalLane(req(), deps({ transport: t }));
  assert.equal(r.accepted, false);
  assert.equal(r.rejection, "refused");
  assert.equal(r.attempts[0]!.outcome, "REFUSED");
  assert.match(r.detail, /NO_QUALIFIED_WORKER/);
});

test("CAPACITY_UNAVAILABLE is typed and is not retried when the reason is a DECISION", async () => {
  const { t, calls } = transport({ failCode: "QUEUE_FULL" });
  const r = await runLocalLane(req(), deps({ transport: t }));
  assert.equal(r.rejection, "capacity_unavailable");
  assert.equal(calls.length, 1, "a full queue is a decision, not a hiccup");
  assert.equal(r.retryCount, 0);
});

test("RUNTIME_UNHEALTHY is retried, BOUNDED, and every attempt is accounted for", async () => {
  const { t, calls } = transport({ failCode: "RUNTIME_UNHEALTHY" });
  const r = await runLocalLane(req({ retryPolicy: { maxAttempts: 3 } }), deps({ transport: t }));
  assert.equal(r.accepted, false);
  assert.equal(calls.length, 3, "the attempt budget is the bound");
  assert.equal(r.attempts.length, 3, "every attempt is recorded, not just the last");
  assert.equal(r.retryCount, 2);
});

test("a response the transport could not deliver is never retried", async () => {
  const { t, calls } = transport({ throws: new Error("unparseable body") });
  const r = await runLocalLane(req({ retryPolicy: { maxAttempts: 5 } }), deps({ transport: t }));
  assert.equal(r.rejection, "unknown_outcome");
  assert.equal(calls.length, 1, "repeating a request we demonstrably misunderstand changes nothing");
});

test("a transport failure is a typed result and is not retried into a loop", async () => {
  const { t, calls } = transport({ throws: new Error("ECONNREFUSED") });
  const r = await runLocalLane(req({ retryPolicy: { maxAttempts: 5 } }), deps({ transport: t }));
  assert.equal(r.accepted, false);
  assert.equal(calls.length, 1);
  assert.match(r.detail, /ECONNREFUSED/);
});

test("added latency is capped across retries", async () => {
  let slept = 0;
  const { t } = transport({ failCode: "RUNTIME_UNHEALTHY" });
  const r = await runLocalLane(
    req({ retryPolicy: { maxAttempts: 50, baseDelayMs: 400, maxAddedLatencyMs: 1000 } }),
    deps({ transport: t, sleep: async (ms) => { slept += ms; }, jitter: () => 1 }),
  );
  assert.ok(slept <= 1000, `slept ${slept}ms, above the 1000ms cap`);
  // `addedLatencyMs` is the WHOLE added wait — the backoff sleeps AND the time the calls
  // themselves took — which is the point of the budget (an endpoint that accepts and never
  // answers spends no backoff at all). Asserting it EQUALS the injected sleeps assumed every
  // fake call rounds to 0ms of wall clock, and under load one of them does not: the suite
  // failed 1000 !== 999 for a millisecond of real time. It contains the sleeps and stays
  // within the ceiling; that is the contract.
  assert.ok(r.addedLatencyMs >= slept, `addedLatencyMs ${r.addedLatencyMs} must contain the ${slept}ms slept`);
  assert.ok(r.addedLatencyMs - slept < 1000, "and must not be dominated by unaccounted time");
});

// ── accounting ──────────────────────────────────────────────────────────────

test("token usage is recorded per attempt, so avoided provider work is measurable", async () => {
  const { t } = transport({ usage: { promptTokens: 412, completionTokens: 37 } });
  const r = await runLocalLane(req(), deps({ transport: t }));
  assert.equal(r.attempts[0]!.promptTokens, 412);
  assert.equal(r.attempts[0]!.completionTokens, 37);
});

test("the decision and its reason travel with EVERY result, accepted or not", async () => {
  const { t } = transport();
  for (const mode of ["assist", "auto"] as const) {
    const r = await runLocalLane(req({ mode }), deps({ transport: t }));
    assert.equal(r.decision.mode, mode);
    assert.ok(r.decision.explanation.length > 0, "a decision with no explanation is not reviewable");
  }
});

test("ASSIST never permits fallback; AUTO does", async () => {
  const { t } = transport();
  assert.equal((await runLocalLane(req({ mode: "assist" }), deps({ transport: t }))).decision.fallbackPermitted, false);
  assert.equal((await runLocalLane(req({ mode: "auto" }), deps({ transport: t }))).decision.fallbackPermitted, true);
});

test("the lane NEVER returns anything that could apply an edit — only data", async () => {
  const { t } = transport({ content: "assertion failure" });
  const r = await runLocalLane(req(), deps({ transport: t }));
  // A proposed edit is data ikbi may later apply through the governed mutation path. The lane
  // itself hands back no callable, no handle, and no path it has written to.
  assert.equal(typeof r.artifact, "object");
  for (const v of Object.values(r.artifact as Record<string, unknown>)) assert.notEqual(typeof v, "function");
  assert.equal((r as unknown as Record<string, unknown>)["apply"], undefined);
});

// ── the added-latency ceiling must bound the WAITING, not just the sleeping ───

/**
 * `BUILD_LOCAL_RETRY` declares a 1500ms "hard latency ceiling" and explains why: "a build that
 * waits on a sick local appliance is a build that has forgotten which of the two is optional".
 *
 * `latencySpent` accumulated only the retry BACKOFF. The call itself — the part that actually
 * costs a build its time — was never counted, so the ceiling could not fire on the case it exists
 * for: an endpoint that accepts a connection and then says nothing. Bounded only by the lane's
 * 120s default, an ordinary two-hook build measured 240s of dead wait with no advisory to show
 * for it and nothing said to the operator while it waited.
 */
test("added-latency budget counts the CALL, not only the backoff", async () => {
  let clock = 0;
  const SLOW_MS = 5_000;
  const slow: InvocationTransport = {
    send: async () => {
      clock += SLOW_MS; // the call itself takes real time
      return { ok: false, failure: { code: "RUNTIME_UNHEALTHY", message: "unhealthy", providerId: "bokahli", attempts: 1 } };
    },
  } as unknown as InvocationTransport;

  const r = await runLocalLane(
    req({ retryPolicy: { maxAttempts: 5, baseDelayMs: 10, maxAddedLatencyMs: 1_500 } }),
    deps({ transport: slow, now: () => clock, sleep: async () => undefined }),
  );

  assert.equal(r.accepted, false);
  // One slow call already blows a 1500ms budget, so the lane must stop rather than keep waiting.
  assert.equal(r.attempts.length, 1, `expected the budget to stop retrying after one slow call, got ${r.attempts.length}`);
  assert.ok(r.addedLatencyMs >= SLOW_MS, `the call's ${SLOW_MS}ms must be counted, got ${r.addedLatencyMs}`);
  assert.match(String(r.detail), /added-latency cap reached/);
});

test("a retryable local failure still retries when the calls are FAST", async () => {
  // The budget must not have become so strict that a healthy lane stops working.
  let clock = 0;
  let sends = 0;
  const quick: InvocationTransport = {
    send: async () => {
      sends += 1;
      clock += 5; // fast call
      return { ok: false, failure: { code: "RUNTIME_UNHEALTHY", message: "unhealthy", providerId: "bokahli", attempts: 1 } };
    },
  } as unknown as InvocationTransport;

  const r = await runLocalLane(
    req({ retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxAddedLatencyMs: 1_500 } }),
    deps({ transport: quick, now: () => clock, sleep: async () => undefined }),
  );
  assert.equal(sends, 3, "fast calls stay within budget and exhaust the attempt allowance");
  assert.equal(r.accepted, false);
});
