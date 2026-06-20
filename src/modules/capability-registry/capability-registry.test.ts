/**
 * ikbi capability-registry consumer tests (L6 req #1): deny-by-default + fail-closed,
 * and that ikbi reads the shared canonical registry as data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, validateRegistry, loadRegistry, loadAndEvaluate, DECISION } from "./index.js";
import type { CapabilityRegistry } from "./index.js";

function fixture(): CapabilityRegistry {
  const r = validateRegistry({
    version: "1",
    capabilities: [
      {
        id: "ikbi-reader",
        actor: "ikbi-worker",
        workspaceRoots: ["/ws/shadow"],
        operations: ["read"],
        riskLevel: "low",
        environment: "shadow",
        network: { policy: "deny", allowHosts: [] },
        maxAutonomyTier: "shadow",
        allowedTools: ["read_file"],
        allowedDelegationDepth: 0,
        budget: { maxTokens: 1000, maxToolCalls: 10 },
      },
    ],
  });
  if (!r.ok) throw new Error(r.reason);
  return r.registry;
}

test("ikbi worker with read capability cannot write", () => {
  const reg = fixture();
  assert.equal(evaluate(reg, { actor: "ikbi-worker", workspaceRoot: "/ws/shadow/x", operation: "read", riskLevel: "low", environment: "shadow" }).allowed, true);
  const w = evaluate(reg, { actor: "ikbi-worker", workspaceRoot: "/ws/shadow/x", operation: "patch-propose", riskLevel: "low", environment: "shadow" });
  assert.equal(w.allowed, false);
  assert.equal(w.code, DECISION.OPERATION_MISMATCH);
});

test("unknown / wildcard actor denied; no-network actor cannot fetch", () => {
  const reg = fixture();
  assert.equal(evaluate(reg, { actor: "nobody", workspaceRoot: "/ws/shadow", operation: "read", riskLevel: "low", environment: "shadow" }).code, DECISION.ACTOR_UNKNOWN);
  assert.equal(evaluate(reg, { actor: "*", workspaceRoot: "/ws/shadow", operation: "read", riskLevel: "low", environment: "shadow" }).code, DECISION.ACTOR_WILDCARD);
  assert.equal(
    evaluate(reg, { actor: "ikbi-worker", workspaceRoot: "/ws/shadow", operation: "read", riskLevel: "low", environment: "shadow", network: { host: "evil.example.com" } }).code,
    DECISION.NETWORK_MISMATCH,
  );
});

test("malformed / missing registry fails closed", () => {
  assert.equal(validateRegistry(null).ok, false);
  assert.equal(validateRegistry({ version: "1", capabilities: [{ id: "x", actor: "a" }] }).ok, false);
  const missing = loadRegistry("/nonexistent/registry.json");
  assert.equal(missing.ok, false);
  const ev = loadAndEvaluate("/nonexistent/registry.json", { actor: "ikbi-worker", workspaceRoot: "/ws", operation: "read", riskLevel: "low", environment: "shadow" });
  assert.equal(ev.allowed, false);
});

test("ikbi reads the shared canonical registry: real-repo read allowed, write denied", () => {
  const path = "/pehverse/repos/ecosystem/lab-capability/registry.json";
  const loaded = loadRegistry(path);
  // The shared registry should exist in the lab; if not, skip rather than fail CI on a
  // machine without the sibling repo checked out.
  if (!loaded.ok) return;
  const read = loadAndEvaluate(path, { actor: "ikbi-worker", workspaceRoot: "/pehverse/repos/ecosystem/ikbi/src", operation: "read", riskLevel: "low", environment: "real" });
  assert.equal(read.allowed, true, read.reason);
  const write = loadAndEvaluate(path, { actor: "ikbi-worker", workspaceRoot: "/pehverse/repos/ecosystem/ikbi/src", operation: "patch-propose", riskLevel: "low", environment: "real" });
  assert.equal(write.allowed, false);
});
