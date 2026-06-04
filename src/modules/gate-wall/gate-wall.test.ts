import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../../core/identity/contract.js";
import type { EventInput } from "../../core/events/index.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { TrustTier } from "../../core/identity/contract.js";
import { createGateWall } from "./gate.js";
import type { GateEventPayload } from "./events.js";
import type { GateWallEvaluateInput } from "./contract.js";

const IDENTITY: AgentIdentity = { agentId: "agent-7", functionalRole: "lead", trustTier: "verified" };
const TASK = { taskId: "t-1", targetRepo: "/repo", goal: "ship it" };

function harness(enabled = true) {
  const events: EventInput<GateEventPayload>[] = [];
  const receiptCalls: Array<{ input: Record<string, unknown>; identity: AgentIdentity }> = [];
  const gw = createGateWall({
    config: { enabled },
    publish: (e) => events.push(e),
    receipts: {
      append: async (input, identity) => {
        receiptCalls.push({ input: input as Record<string, unknown>, identity });
        return {};
      },
    },
    newGateId: () => "gate-test-1",
  });
  return { gw, events, receiptCalls };
}

function input(tier: TrustTier): GateWallEvaluateInput {
  return { grant: autonomyForTier(tier), task: TASK, results: [], identity: IDENTITY };
}

test("a non-approval tier (verified) → allow:true, reason cites the tier", async () => {
  const { gw } = harness();
  const g = await gw.evaluate(input("verified"));
  assert.equal(g.allow, true);
  assert.match(g.reason ?? "", /verified/);
  assert.ok(g.gateId);
});

test("a requiresApproval tier (probation) → allow:FALSE, fail-closed reason + gateId", async () => {
  const { gw } = harness();
  const g = await gw.evaluate(input("probation"));
  assert.equal(g.allow, false);
  assert.match(g.reason ?? "", /requires operator approval/);
  assert.match(g.reason ?? "", /fail-closed/);
  assert.equal(g.gateId, "gate-test-1");
});

test("untrusted is also denied fail-closed", async () => {
  const { gw } = harness();
  assert.equal((await gw.evaluate(input("untrusted"))).allow, false);
});

test("disabled gate-wall denies (no allow-all bypass)", async () => {
  const { gw } = harness(false);
  const g = await gw.evaluate(input("trusted")); // trusted would normally allow
  assert.equal(g.allow, false);
  assert.match(g.reason ?? "", /disabled/);
});

test("emits gate.evaluated + gate.allowed on an allow", async () => {
  const { gw, events } = harness();
  await gw.evaluate(input("trusted"));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["gate.evaluated", "gate.allowed"]);
  for (const e of events) {
    assert.equal(e.source, "gate-wall");
    assert.equal(e.attribution?.identity?.agentId, "agent-7");
    assert.equal((e.payload as GateEventPayload).allow, true);
    assert.equal((e.payload as GateEventPayload).gateId, "gate-test-1");
  }
});

test("emits gate.evaluated + gate.denied on a deny", async () => {
  const { gw, events } = harness();
  await gw.evaluate(input("probation"));
  assert.deepEqual(events.map((e) => e.type), ["gate.evaluated", "gate.denied"]);
  assert.equal((events[1]?.payload as GateEventPayload).allow, false);
});

test("writes an attributed receipt; the EVALUATION is outcome:success even on deny", async () => {
  const { gw, receiptCalls } = harness();
  await gw.evaluate(input("probation")); // a DENY
  assert.equal(receiptCalls.length, 1);
  const { input: rinput, identity } = receiptCalls[0]!;
  assert.equal((rinput as { operation: string }).operation, "gate.evaluate");
  assert.equal((rinput as { outcome: { status: string } }).outcome.status, "success", "the evaluation succeeded; the deny is in metadata");
  const meta = (rinput as { metadata: Record<string, unknown> }).metadata;
  assert.equal(meta.allow, false);
  assert.equal(meta.gateId, "gate-test-1");
  assert.match(String(meta.reason), /requires operator approval/);
  assert.equal(identity.agentId, "agent-7", "receipt attributed to the evaluated identity");
});
