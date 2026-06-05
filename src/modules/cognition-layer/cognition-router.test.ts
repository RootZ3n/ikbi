import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { createCognitionRouter, parseRouterArgs, suggestedCommand } from "./cli.js";
import type { CognitionDecision, CognitionInput, CognitionLayer } from "./contract.js";

const silent = () => pino({ level: "silent" });
const OPERATOR_TOKEN = "operator-token-value";

function operatorResolver() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "operator", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken(OPERATOR_TOKEN)] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return (claim: { token?: string }) => resolver.resolve(claim);
}

/** A cognition fake that records the input and returns a chosen decision. */
function fakeCognition(decision: CognitionDecision) {
  const calls: CognitionInput[] = [];
  const cognition: CognitionLayer = { deliberate: async (input) => { calls.push(input); return decision; } };
  return { cognition, calls };
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

const decision = (over: Partial<CognitionDecision> = {}): CognitionDecision => ({ decision: "plan", confidence: 0.8, rationale: "multi-step", memoryUsed: [], ...over });

// ── args + suggestion mapping (pure) ─────────────────────────────────────────

test("parseRouterArgs extracts --project; suggestedCommand maps the recommendation to a command", () => {
  assert.deepEqual(parseRouterArgs(["fix", "the", "bug", "--project", "demo"]), { project: "demo", rest: ["fix", "the", "bug"] });
  assert.equal(suggestedCommand(decision({ recommendedNext: { module: "batch-planner", action: "planAndRun", payload: {} } }), "g"), 'ikbi batch "g"');
  assert.equal(suggestedCommand(decision({ recommendedNext: { module: "worker-model", action: "build", payload: {} } }), "g"), 'ikbi build "g"');
  assert.equal(suggestedCommand(decision({ decision: "answer", recommendedNext: { module: "agent-router", action: "ask", payload: {} } }), "g"), 'ikbi ask "g"');
  assert.match(suggestedCommand(decision({ decision: "ask", missingInfo: ["which repo?"] }), "g"), /clarify:.*which repo/);
  assert.match(suggestedCommand(decision({ decision: "warn", risks: ["builder drifting"] }), "g"), /caution:.*drifting/);
});

// ── the router deliberates + reports + suggests (no auto-execute) ────────────

test("the default router deliberates and REPORTS the decision + suggested command", () => {
  const fc = fakeCognition(decision({ decision: "plan", confidence: 0.9, rationale: "needs decomposition", memoryUsed: ["m1", "m2"], recommendedNext: { module: "batch-planner", action: "planAndRun", payload: {} } }));
  const cap = capture();
  const router = createCognitionRouter({ cognition: fc.cognition, resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });

  return router.route(["add", "a", "feature", "and", "tests", "--project", "demo"]).then(() => {
    assert.equal(cap.exit, undefined, "a clean deliberation exits 0");
    assert.equal(fc.calls.length, 1, "cognition was consulted");
    assert.equal(fc.calls[0]?.goal, "add a feature and tests", "the whole input is the goal");
    assert.equal(fc.calls[0]?.project, "demo");
    assert.match(cap.out, /decision: plan \(confidence 90%\)/);
    assert.match(cap.out, /rationale: needs decomposition/);
    assert.match(cap.out, /memory used: 2 entries/);
    assert.match(cap.out, /next: ikbi batch "add a feature and tests"/, "recommends the command — does not run it");
  });
});

// ── fail-closed ──────────────────────────────────────────────────────────────

test("no operator token ⇒ friendly error, no deliberation", () => {
  const fc = fakeCognition(decision());
  const cap = capture();
  const router = createCognitionRouter({ cognition: fc.cognition, resolveIdentity: operatorResolver(), operatorToken: undefined, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return router.route(["do", "something"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /no operator identity.*IKBI_OPERATOR_TOKEN/);
    assert.equal(fc.calls.length, 0, "no deliberation without an identity");
  });
});

test("an empty goal ⇒ usage hint, no deliberation", () => {
  const fc = fakeCognition(decision());
  const cap = capture();
  const router = createCognitionRouter({ cognition: fc.cognition, resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return router.route(["--project", "demo"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /nothing to deliberate/);
    assert.equal(fc.calls.length, 0);
  });
});

test("a deliberation error is reported cleanly (no raw stack)", () => {
  const cognition: CognitionLayer = { deliberate: async () => { throw new Error("401 unauthorized: bad key"); } };
  const cap = capture();
  const router = createCognitionRouter({ cognition, resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return router.route(["build", "a", "thing"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /deliberation failed:.*401 unauthorized/);
    assert.match(cap.err, /IKBI_MIMO_API_KEY/);
    assert.ok(!cap.err.includes("\n    at "), "no raw stack frames leaked");
  });
});
