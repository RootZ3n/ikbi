/**
 * C9 — the model-request construction guard: a `role:"tool"` message must carry an EXPLICIT `untrusted`
 * trust decision (true = neutralized external content via toUntrustedMessage; false = deliberate
 * ikbi-authored harness feedback). An untriaged tool result (flag undefined) is a bare tool-result
 * string — a neutralization-chokepoint bypass — and is refused fail-closed at invokeModel/Stream.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// Side-effect: the network-egress floor registers the fetch guard the default registry needs at load.
import "../../modules/egress/index.js";
import type { ModelRequest } from "./contract.js";
import { invokeModel, invokeModelStream, UntriagedToolMessageError } from "./index.js";

const ID = { agentId: "guard-test" };

test("C9: invokeModel REJECTS a bare role:tool message (no explicit untrusted flag)", async () => {
  const req: ModelRequest = {
    model: "mimo-v2.5",
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "raw external tool output", toolCallId: "c1" }, // untriaged — the bypass
    ],
    identity: ID,
  };
  await assert.rejects(
    () => invokeModel(req),
    (e: unknown) => e instanceof UntriagedToolMessageError && e.index === 1,
    "the untriaged tool message is refused before any provider call",
  );
});

test("C9: invokeModelStream applies the SAME guard", async () => {
  const req: ModelRequest = {
    model: "mimo-v2.5",
    messages: [{ role: "tool", content: "x", toolCallId: "c1" }],
    identity: ID,
  };
  await assert.rejects(() => invokeModelStream(req), (e: unknown) => e instanceof UntriagedToolMessageError);
});

test("C9: a TRIAGED tool message (untrusted true OR false) PASSES the guard (any failure is downstream)", async () => {
  for (const untrusted of [true, false] as const) {
    const req: ModelRequest = {
      model: "nonexistent-model-zzz", // fails at model resolution — NOT at the C9 guard
      messages: [{ role: "tool", content: "x", toolCallId: "c1", untrusted }],
      identity: ID,
    };
    await assert.rejects(
      () => invokeModel(req),
      (e: unknown) => !(e instanceof UntriagedToolMessageError),
      `untrusted:${untrusted} is a valid trust decision — the guard lets it through`,
    );
  }
});

test("C9: a request with no tool messages is unaffected (user/assistant/system pass through)", async () => {
  const req: ModelRequest = {
    model: "nonexistent-model-zzz",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "prior" },
    ],
    identity: ID,
  };
  await assert.rejects(() => invokeModel(req), (e: unknown) => !(e instanceof UntriagedToolMessageError));
});
