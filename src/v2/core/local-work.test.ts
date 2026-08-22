/**
 * HOSTILE TESTS for the local-work authority.
 *
 * The interesting failures of a local lane are not crashes. They are an unqualified answer that
 * quietly becomes a qualified one, a citation to text the model was never shown, a retry loop that
 * is "bounded" by a number nobody multiplied out, and a fallback to a paid provider that nobody
 * was told about. Each of those is a test here, written as the attack rather than as the feature.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ELIGIBLE_TASK_CLASSES,
  INELIGIBLE_TASK_CLASSES,
  acceptLocalResponse,
  authorizeFallback,
  decideLocalOffload,
  decideLocalRetry,
  resolveCitations,
  type LocalMode,
  type LocalOffloadInput,
} from "./local-work.js";

/** An input that is eligible in every respect, so each test can spoil exactly one thing. */
function ok(over: Partial<LocalOffloadInput> = {}): LocalOffloadInput {
  return {
    mode: "auto",
    taskClass: "test_log_triage",
    hasValidator: true,
    packetBounded: true,
    requireQualified: false,
    state: { configured: true, reachable: true, consecutiveFailures: 0 },
    ...over,
  };
}

// ── mode + configuration ────────────────────────────────────────────────────

test("OFF makes ZERO local requests, whatever else is true", () => {
  // OFF is checked before eligibility, health, or even whether Bokahli exists.
  for (const taskClass of ELIGIBLE_TASK_CLASSES) {
    const d = decideLocalOffload(ok({ mode: "off", taskClass }));
    assert.equal(d.offload, false);
    assert.equal(d.reason, "mode_off");
    assert.equal(d.fallbackPermitted, false);
  }
});

test("an absent Bokahli configuration is not an error — ikbi simply does not use it", () => {
  const d = decideLocalOffload(ok({ state: { configured: false } }));
  assert.equal(d.offload, false);
  assert.equal(d.reason, "not_configured");
  assert.match(d.explanation, /as if it did not exist/);
});

test("an UNPROBED deployment is allowed to try — only an explicit false refuses", () => {
  assert.equal(decideLocalOffload(ok({ state: { configured: true } })).offload, true);
  assert.equal(decideLocalOffload(ok({ state: { configured: true, reachable: false } })).reason, "unreachable");
});

// ── eligibility ─────────────────────────────────────────────────────────────

test("every ineligible class is refused, and refused for its OWN reason", () => {
  for (const taskClass of Object.keys(INELIGIBLE_TASK_CLASSES)) {
    const d = decideLocalOffload(ok({ taskClass }));
    assert.equal(d.offload, false, `${taskClass} must never reach a local worker`);
    assert.equal(d.reason, "task_class_ineligible");
  }
});

test("an ineligible task is refused even when Bokahli is DOWN — the record names the real reason", () => {
  // Otherwise an operator reading the log learns that afternoon's uptime, not the policy.
  const d = decideLocalOffload(ok({ taskClass: "credential_handling", state: { configured: false, reachable: false } }));
  assert.equal(d.reason, "task_class_ineligible");
});

test("an unknown task class is ineligible — unknown is never favorable", () => {
  assert.equal(decideLocalOffload(ok({ taskClass: "summarise_the_vibes" })).reason, "task_class_unknown");
  assert.equal(decideLocalOffload(ok({ taskClass: "" })).reason, "task_class_unknown");
});

test("no deterministic validator means no local execution", () => {
  assert.equal(decideLocalOffload(ok({ hasValidator: false })).reason, "no_deterministic_validator");
});

test("an unbounded packet is refused — a worker receives a packet, never a repository", () => {
  assert.equal(decideLocalOffload(ok({ packetBounded: false })).reason, "packet_unbounded");
});

test("a failing local lane stops being chosen once the budget is spent", () => {
  assert.equal(decideLocalOffload(ok({ state: { configured: true, consecutiveFailures: 3 } })).reason, "failure_budget_exhausted");
  assert.equal(decideLocalOffload(ok({ state: { configured: true, consecutiveFailures: 2 } })).offload, true);
});

// ── determinism ─────────────────────────────────────────────────────────────

test("AUTO is DETERMINISTIC — identical inputs give an identical decision, every time", () => {
  const input = ok();
  const first = decideLocalOffload(input);
  for (let i = 0; i < 50; i += 1) assert.deepEqual(decideLocalOffload(input), first);
});

test("every mode/class pair is reproducible, so an AUTO decision can be reviewed after the fact", () => {
  const modes: LocalMode[] = ["off", "assist", "auto", "exact"];
  const seen = new Map<string, string>();
  for (const mode of modes) {
    for (const taskClass of [...ELIGIBLE_TASK_CLASSES, ...Object.keys(INELIGIBLE_TASK_CLASSES), "nonsense"]) {
      const key = `${mode}/${taskClass}`;
      const d = decideLocalOffload(ok({ mode, taskClass }));
      seen.set(key, `${d.offload}:${d.reason}`);
      // Re-deciding must not drift.
      const again = decideLocalOffload(ok({ mode, taskClass }));
      assert.equal(`${again.offload}:${again.reason}`, seen.get(key), `${key} was not reproducible`);
    }
  }
});

// ── fallback ────────────────────────────────────────────────────────────────

test("ASSIST never falls back — the operator gets a typed local failure, not a surprise bill", () => {
  const d = decideLocalOffload(ok({ mode: "assist" }));
  assert.equal(d.offload, true);
  assert.equal(d.fallbackPermitted, false);

  const f = authorizeFallback({
    decision: d, rejection: "capacity_unavailable", failureReason: "queue full",
    retryCount: 1, fallbackProvider: "anthropic", addedLatencyMs: 300, hadPartialOutput: false,
  });
  assert.equal(f.permitted, false);
  assert.match(f.detail, /never substitutes the primary provider unasked/);
  assert.equal(f.event, undefined, "a refused fallback must not leave a record saying it happened");
});

test("AUTO fallback is permitted and ALWAYS produces a full accounting record", () => {
  const d = decideLocalOffload(ok({ mode: "auto" }));
  const f = authorizeFallback({
    decision: d, rejection: "escalated", failureReason: "CONTEXT_TOO_LARGE",
    retryCount: 2, fallbackProvider: "anthropic", addedLatencyMs: 812, hadPartialOutput: true,
    attempted: { modelId: "qwen3.5-35b-a3b.q2-k", artifactDigest: "sha256:49533d" },
  });
  assert.equal(f.permitted, true);
  const e = f.event!;
  // Every field the operator needs to understand what they were charged for and why.
  assert.equal(e.localDecision, "escalated");
  assert.equal(e.attemptedModelId, "qwen3.5-35b-a3b.q2-k");
  assert.equal(e.attemptedArtifactDigest, "sha256:49533d");
  assert.equal(e.failureReason, "CONTEXT_TOO_LARGE");
  assert.equal(e.retryCount, 2);
  assert.equal(e.fallbackProvider, "anthropic");
  assert.equal(e.addedLatencyMs, 812);
  assert.equal(e.partialOutputDiscarded, true);
});

test("partial local output is DISCARDED on escalation, never spliced into the fallback answer", () => {
  const d = decideLocalOffload(ok({ mode: "auto" }));
  const f = authorizeFallback({
    decision: d, rejection: "escalated", failureReason: "escalated mid-stream",
    retryCount: 0, fallbackProvider: "anthropic", addedLatencyMs: 10, hadPartialOutput: true,
  });
  assert.equal(f.event!.partialOutputDiscarded, true);
});

test("a refused OFFLOAD cannot fall back either — there was no local attempt to fall back FROM", () => {
  const d = decideLocalOffload(ok({ mode: "off" }));
  assert.equal(authorizeFallback({
    decision: d, rejection: "mode_off", failureReason: "n/a", retryCount: 0,
    fallbackProvider: "anthropic", addedLatencyMs: 0, hadPartialOutput: false,
  }).permitted, false);
});

// ── accepting a response ────────────────────────────────────────────────────

const ATTESTED_UNQUALIFIED = {
  modelId: "qwen3.5-35b-a3b.q2-k",
  artifactDigest: "sha256:4953",
  attested: true,
  qualificationStatus: "INSTALLED_UNQUALIFIED",
};

test("an unknown outcome FAILS CLOSED", () => {
  for (const outcome of ["OK", "SUCCESS", "", "routed", "ROUTED_MAYBE"]) {
    const a = acceptLocalResponse({ outcome, attested: ATTESTED_UNQUALIFIED }, { requireQualified: false, requireAttestation: false });
    assert.equal(a.accepted, false, `${JSON.stringify(outcome)} must not be accepted`);
    assert.equal(a.rejection, "unknown_outcome");
  }
});

test("every typed refusal is a TYPED rejection, not a parse failure", () => {
  const cases = [["REFUSED", "refused"], ["ESCALATE", "escalated"], ["CAPACITY_UNAVAILABLE", "capacity_unavailable"]] as const;
  for (const [outcome, rejection] of cases) {
    const a = acceptLocalResponse({ outcome, reason: "NO_QUALIFIED_WORKER" }, { requireQualified: false, requireAttestation: false });
    assert.equal(a.accepted, false);
    assert.equal(a.rejection, rejection);
    assert.match(a.detail, /NO_QUALIFIED_WORKER/);
  }
});

test("a ROUTED carrying a refusal reason is a PROTOCOL disagreement, not a result", () => {
  const a = acceptLocalResponse({ outcome: "ROUTED", reason: "NO_QUALIFIED_WORKER", attested: ATTESTED_UNQUALIFIED },
    { requireQualified: false, requireAttestation: false });
  assert.equal(a.accepted, false);
  assert.equal(a.rejection, "reason_outcome_mismatch");
});

test("requireQualified is NEVER downgraded to supervised execution", () => {
  // This is the flag's entire purpose. Every artifact on the real deployment reports
  // INSTALLED_UNQUALIFIED, so a downgrade here would be silent and universal.
  const a = acceptLocalResponse({ outcome: "ROUTED", attested: ATTESTED_UNQUALIFIED },
    { requireQualified: true, requireAttestation: false });
  assert.equal(a.accepted, false);
  assert.equal(a.rejection, "unqualified_artifact");
  assert.equal(a.supervision, undefined, "a refusal must not hand back a supervision mark to act on");
});

test("unqualified evidence cannot become qualified by CLAIMING to be", () => {
  // A deployment asserting a status ikbi does not recognise is not qualified.
  for (const status of ["QUALIFIED_ISH", "qualified", "TRUSTED", "", "UNKNOWN"]) {
    const a = acceptLocalResponse({ outcome: "ROUTED", attested: { ...ATTESTED_UNQUALIFIED, qualificationStatus: status } },
      { requireQualified: true, requireAttestation: false });
    assert.equal(a.accepted, false, `${JSON.stringify(status)} must not satisfy requireQualified`);
  }
});

test("an accepted unqualified result is stamped supervised — review required, promotion forbidden", () => {
  const a = acceptLocalResponse({ outcome: "ROUTED", attested: ATTESTED_UNQUALIFIED },
    { requireQualified: false, requireAttestation: true });
  assert.equal(a.accepted, true);
  assert.deepEqual(a.supervision, {
    executionClass: "local",
    qualified: false,
    humanReviewRequired: true,
    autonomousPromotionAllowed: false,
    reason: "artifact qwen3.5-35b-a3b.q2-k reported INSTALLED_UNQUALIFIED",
  });
});

test("even a QUALIFIED local result may not promote autonomously", () => {
  const a = acceptLocalResponse({ outcome: "ROUTED", attested: { ...ATTESTED_UNQUALIFIED, qualificationStatus: "QUALIFIED" } },
    { requireQualified: true, requireAttestation: true });
  assert.equal(a.accepted, true);
  assert.equal(a.supervision!.qualified, true);
  assert.equal(a.supervision!.humanReviewRequired, false);
  // Promotion is ikbi's authority. Qualification buys trust in the ANSWER, not the authority.
  assert.equal(a.supervision!.autonomousPromotionAllowed, false);
});

test("a WRONG artifact is rejected — never silently substituted", () => {
  const a = acceptLocalResponse(
    { outcome: "ROUTED", attested: ATTESTED_UNQUALIFIED, expectedModelId: "gemma4-12b.q6-k" },
    { requireQualified: false, requireAttestation: false },
  );
  assert.equal(a.rejection, "identity_mismatch");
});

test("a wrong DIGEST is rejected even when the model NAME matches", () => {
  // The name is what the runtime chose to report; the digest is what it can prove.
  const a = acceptLocalResponse(
    { outcome: "ROUTED", attested: ATTESTED_UNQUALIFIED, expectedModelId: ATTESTED_UNQUALIFIED.modelId, expectedDigest: "sha256:different" },
    { requireQualified: false, requireAttestation: false },
  );
  assert.equal(a.rejection, "digest_mismatch");
});

test("unattested identity is rejected when attestation is required", () => {
  for (const attested of [{ ...ATTESTED_UNQUALIFIED, attested: false }, undefined]) {
    const a = acceptLocalResponse({ outcome: "ROUTED", ...(attested ? { attested } : {}) }, { requireQualified: false, requireAttestation: true });
    assert.equal(a.accepted, false);
    assert.equal(a.rejection, "unattested_identity");
  }
});

// ── citations ───────────────────────────────────────────────────────────────

const PACKET = [{ id: "log:1", content: "FAIL src/widget.test.ts: expected 2, got 1\n" }];

test("a citation that resolves exactly is accepted", () => {
  const r = resolveCitations(PACKET, [{ sourceId: "log:1", quote: "expected 2, got 1" }]);
  assert.equal(r.resolved, true);
  assert.deepEqual(r.unresolved, []);
});

test("an INVENTED citation is unresolved — the packet is the only ground truth", () => {
  const r = resolveCitations(PACKET, [{ sourceId: "log:1", quote: "expected 3, got 1" }]);
  assert.equal(r.resolved, false);
  assert.equal(r.unresolved.length, 1);
});

test("a citation to a source that was never supplied is unresolved", () => {
  assert.equal(resolveCitations(PACKET, [{ sourceId: "log:99", quote: "anything" }]).resolved, false);
});

test("an EMPTY quote never resolves — citing nothing is not citing", () => {
  assert.equal(resolveCitations(PACKET, [{ sourceId: "log:1", quote: "" }]).resolved, false);
});

test("citation matching is EXACT, not fuzzy — near-misses do not pass", () => {
  // A "close enough" citation check is a citation check that passes for invented text.
  assert.equal(resolveCitations(PACKET, [{ sourceId: "log:1", quote: "expected 2,got 1" }]).resolved, false);
  assert.equal(resolveCitations(PACKET, [{ sourceId: "log:1", quote: "EXPECTED 2, GOT 1" }]).resolved, false);
});

test("no citations at all is trivially resolved — the caller decides whether citations were required", () => {
  assert.equal(resolveCitations(PACKET, []).resolved, true);
});

// ── retry ───────────────────────────────────────────────────────────────────

const HEALTHY_RETRY = { rejection: "capacity_unavailable", capacityReason: "RUNTIME_UNHEALTHY", attemptsMade: 1, latencySpentMs: 0 } as const;

test("RUNTIME_UNHEALTHY is retried, once, with a jittered delay", () => {
  const r = decideLocalRetry(HEALTHY_RETRY, {}, 0.5);
  assert.equal(r.retry, true);
  assert.ok(r.delayMs > 0 && r.delayMs <= 250, `expected a short jittered delay, got ${r.delayMs}`);
});

test("jitter changes the delay but never the DECISION", () => {
  for (const j of [0, 0.25, 0.5, 0.75, 1]) {
    const r = decideLocalRetry(HEALTHY_RETRY, {}, j);
    assert.equal(r.retry, true);
    assert.ok(r.delayMs >= 0);
  }
});

test("a malformed protocol, an identity mismatch and a refusal are NEVER retried", () => {
  // Each is a stable fact about this request. Repeating it spends latency to learn what we know.
  for (const rejection of ["unknown_outcome", "reason_outcome_mismatch", "identity_mismatch", "digest_mismatch",
    "unattested_identity", "refused", "escalated", "unqualified_artifact", "validator_rejected", "citation_unresolved"] as const) {
    const r = decideLocalRetry({ rejection, attemptsMade: 1, latencySpentMs: 0 });
    assert.equal(r.retry, false, `${rejection} must not be retried`);
    assert.match(r.reason, /stable fact/);
  }
});

test("a capacity DECISION (queue full, concurrency limit) is not a transient fault", () => {
  for (const capacityReason of ["QUEUE_FULL", "CONCURRENCY_LIMIT"]) {
    assert.equal(decideLocalRetry({ ...HEALTHY_RETRY, capacityReason }).retry, false);
  }
});

test("the deployment's own retryable=false outranks ikbi's optimism", () => {
  assert.equal(decideLocalRetry({ ...HEALTHY_RETRY, retryableLocal: false }).retry, false);
});

test("retries are BOUNDED by attempts", () => {
  assert.equal(decideLocalRetry({ ...HEALTHY_RETRY, attemptsMade: 2 }).retry, false);
  assert.equal(decideLocalRetry({ ...HEALTHY_RETRY, attemptsMade: 9 }).retry, false);
});

test("retries are BOUNDED by total added latency, independently of the attempt count", () => {
  const r = decideLocalRetry({ ...HEALTHY_RETRY, attemptsMade: 1, latencySpentMs: 2000 }, { maxAttempts: 99 });
  assert.equal(r.retry, false);
  assert.match(r.reason, /added-latency cap/);
});

test("a delay can never exceed the REMAINING latency budget", () => {
  // A bounded policy must not become an unbounded wait by arithmetic.
  const r = decideLocalRetry({ ...HEALTHY_RETRY, attemptsMade: 3, latencySpentMs: 1900 }, { maxAttempts: 99, baseDelayMs: 5000, maxAddedLatencyMs: 2000 }, 1);
  assert.equal(r.retry, true);
  assert.ok(r.delayMs <= 100, `delay ${r.delayMs} exceeded the remaining budget`);
});

test("a retry loop driven to exhaustion terminates and accounts for every attempt", () => {
  let attempts = 0;
  let latency = 0;
  for (;;) {
    const r = decideLocalRetry({ ...HEALTHY_RETRY, attemptsMade: attempts + 1, latencySpentMs: latency }, { maxAttempts: 5, baseDelayMs: 200 }, 1);
    attempts += 1;
    if (!r.retry) break;
    latency += r.delayMs;
    assert.ok(attempts < 20, "the retry loop did not terminate");
  }
  assert.ok(attempts <= 5, `attempts ${attempts} exceeded the budget`);
  assert.ok(latency <= 2000, `added latency ${latency}ms exceeded the cap`);
});
