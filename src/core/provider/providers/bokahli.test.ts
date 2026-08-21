/**
 * Two properties, both about what must NOT happen.
 *
 * A local deployment declining to serve must not turn into a paid API call, and
 * the Bokahli token must not reach anywhere it could be read from — argv, an
 * environment, a log line, a serialised receipt.
 *
 * Both are failures that succeed. The paid call returns a perfectly good answer
 * and bills for it; the leaked token sits in a receipt nobody reads until
 * someone does. Neither shows up as a test going red unless a test is written
 * for the absence, so these assert on absence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOKAHLI_ESCALATE_REASONS,
  BOKAHLI_PROVIDER_ID,
  BokahliEscalation,
  assertPrivateKeyFile,
  readEscalation,
} from "./bokahli.js";
import { terminatesChain } from "../contract.js";

const SECRET = "bokahli-token-do-not-leak-2f4a9c1e";

function tokenFile(mode: number, contents = SECRET): string {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-bokahli-"));
  const p = join(dir, "token");
  writeFileSync(p, `${contents}\n`);
  chmodSync(p, mode);
  return p;
}

// ---------------------------------------------------------------------------
// Credential handling

test("a mode-0600 token file is read", () => {
  assert.equal(assertPrivateKeyFile(tokenFile(0o600)), SECRET);
});

test("a group-readable token file is refused, not warned about", () => {
  // Refused before the read. A warning arrives after the secret is already in a
  // process that will go on to use it.
  assert.throws(
    () => assertPrivateKeyFile(tokenFile(0o640)),
    /must not be readable by group or others/,
  );
});

test("a world-readable token file is refused", () => {
  assert.throws(() => assertPrivateKeyFile(tokenFile(0o644)), /mode 0644/);
});

test("a missing token file fails with a fixable message and no stack-diving", () => {
  assert.throws(
    () => assertPrivateKeyFile(join(tmpdir(), "definitely-not-here-9e1f")),
    /Create it with mode 0600/,
  );
});

test("an empty token file is refused rather than sending an empty bearer", () => {
  assert.throws(() => assertPrivateKeyFile(tokenFile(0o600, "   ")), /is empty/);
});

test("the token never appears in an escalation's serialised form", () => {
  // Escalations reach logs and receipts. Nothing that leaves this module may
  // carry the credential, including via a cause chain.
  const e = new BokahliEscalation({
    reason: "MODEL_NOT_QUALIFIED_FOR_TASK",
    detail: "no artifact holds qualification for task class 'triage'",
  });
  const serialised = `${e.message}${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
  assert.ok(!serialised.includes(SECRET));
});

// ---------------------------------------------------------------------------
// A refusal is not a failure

test("every escalation except RUNTIME_UNHEALTHY terminates the chain", () => {
  for (const reason of BOKAHLI_ESCALATE_REASONS) {
    const e = new BokahliEscalation({ reason, detail: "x" });
    if (reason === "RUNTIME_UNHEALTHY") {
      assert.equal(e.terminatesChain, false,
        "a runtime that is temporarily down is an ordinary transient failure");
      assert.equal(e.retriable, true);
    } else {
      assert.equal(e.terminatesChain, true,
        `${reason} is a decision about what this deployment will serve; falling `
          + "through to a paid provider bypasses it rather than addressing it");
      assert.equal(e.retriable, false);
    }
  }
});

test("the invoker's structural check recognises an escalation", () => {
  // terminatesChain() is structural so a provider can raise one without
  // importing the invoker. Verify the two actually agree.
  assert.ok(terminatesChain(new BokahliEscalation({ reason: "REQUIREMENTS_UNMET", detail: "x" })));
  assert.ok(!terminatesChain(new BokahliEscalation({ reason: "RUNTIME_UNHEALTHY", detail: "x" })));
  assert.ok(!terminatesChain(new Error("an ordinary failure")));
  assert.ok(!terminatesChain(undefined));
});

test("REQUIREMENTS_UNMET and LOCAL_MODEL_SWAP_REQUIRED stay distinguishable", () => {
  // The whole reason the swap reason exists. One means "fall back"; the other
  // means "ask an operator to load something". A caller that cannot tell them
  // apart either gives up needlessly or waits for a swap that will not help.
  const unmet = new BokahliEscalation({ reason: "REQUIREMENTS_UNMET", detail: "x" });
  const swap = new BokahliEscalation({
    reason: "LOCAL_MODEL_SWAP_REQUIRED",
    detail: "x",
    swapCandidates: [{ modelId: "qwen3.5-9b.q6-k", coldLoadSeconds: 2.45 }],
  });
  assert.notEqual(unmet.reason, swap.reason);
  assert.equal(unmet.swapCandidates.length, 0);
  assert.equal(swap.swapCandidates[0]?.coldLoadSeconds, 2.45,
    "the swap decision is made against a measured number, not a guess");
});

// ---------------------------------------------------------------------------
// Reading Bokahli's answer

test("a native-dialect escalation is recognised with its reason and swap facts", () => {
  const e = readEscalation({
    outcome: "ESCALATE",
    route: {
      reason: "LOCAL_MODEL_SWAP_REQUIRED",
      detail: "the loaded artifact does not satisfy this request",
      swap: {
        residentModelId: "qwen3.5-35b-a3b.q2-k",
        candidates: [{ modelId: "qwen3.5-9b.q6-k", coldLoadSeconds: 2.45, vramMiB: 7918 }],
      },
    },
  });
  assert.ok(e);
  assert.equal(e.reason, "LOCAL_MODEL_SWAP_REQUIRED");
  assert.equal(e.terminatesChain, true);
  assert.deepEqual(e.swapCandidates, [{ modelId: "qwen3.5-9b.q6-k", coldLoadSeconds: 2.45 }]);
});

test("a REFUSED outcome is recognised too", () => {
  // EXACT refusals must never be answered by substituting another artifact, so
  // they must not fall through to a provider that would happily do exactly that.
  const e = readEscalation({
    outcome: "REFUSED",
    route: { reason: "EXACT_DIGEST_MISMATCH", detail: "digest does not match" },
  });
  assert.ok(e);
  assert.equal(e.terminatesChain, true);
});

test("an OpenAI-dialect error carrying an escalation code is recognised", () => {
  const e = readEscalation({
    error: { code: "NO_QUALIFIED_LOCAL_ROUTE", message: "nothing installed is qualified" },
  });
  assert.ok(e);
  assert.equal(e.reason, "NO_QUALIFIED_LOCAL_ROUTE");
});

test("an ordinary completion is not mistaken for an escalation", () => {
  assert.equal(readEscalation({ choices: [{ message: { content: "hello" } }] }), null);
  assert.equal(readEscalation({ outcome: "ROUTED", route: { reason: null } }), null);
  assert.equal(readEscalation(null), null);
  assert.equal(readEscalation("ESCALATE"), null);
});

test("an unrecognised escalation reason is surfaced, not swallowed", () => {
  // A reason this build has never heard of still means Bokahli declined. Treating
  // it as an ordinary response would let a future reason silently reach a paid
  // provider — the exact failure this integration exists to prevent.
  const e = readEscalation({
    outcome: "ESCALATE",
    route: { reason: "SOME_FUTURE_REASON", detail: "added after this build" },
  });
  assert.ok(e);
  assert.equal(e.reason, "UNKNOWN");
  assert.equal(e.terminatesChain, true);
});

test("an unrelated error code is not treated as an escalation", () => {
  assert.equal(readEscalation({ error: { code: "BAD_REQUEST", message: "malformed" } }), null);
  assert.equal(readEscalation({ error: { code: "UNAUTHORIZED", message: "auth" } }), null);
});

test("the provider id is stable", () => {
  // It is referenced by roster JSON, which is data and will not fail to compile.
  assert.equal(BOKAHLI_PROVIDER_ID, "bokahli");
});
