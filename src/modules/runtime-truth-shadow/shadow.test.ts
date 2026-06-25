import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { pino } from "pino";

import type { EventInput } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/index.js";
import { createCognitionLayer, type ToUntrustedFn, type LabMemoryReader, type DriftReader } from "../cognition-layer/cognition.js";
import type { CognitionLayerConfig } from "../cognition-layer/config.js";
import { runRuntimeTruthShadow, resolveRuntimeTruthMode, parseRuntimeTruthMode } from "./index.js";
import type { RuntimeTruthSummary, RuntimeTruthReaderPort } from "./index.js";

const HERE = new URL(".", import.meta.url).pathname; // src/modules/runtime-truth-shadow/
const COG = new URL("../cognition-layer/cognition.ts", import.meta.url).pathname;

// ── harness ──────────────────────────────────────────────────────────────────
const silent = () => pino({ level: "silent" });
const CFG: CognitionLayerConfig = { enabled: true, maxMemoryEntries: 40 };

function makeCtx(agentId = "ikbi"): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId, kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken(`${agentId}-secret`)] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: `${agentId}-secret` }), { requestId: "req-1" });
}
function modelResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const neutralize = (content: string, context: UntrustedContext): NeutralizedContent =>
  ({ wrapped: `[N]<${content.length}>`, raw: content, body: content, source: context.source } as unknown as NeutralizedContent);
const toUntrusted: ToUntrustedFn = (n, opts) => ({ role: opts?.role ?? "user", content: (n as { wrapped: string }).wrapped, untrusted: true } as ReturnType<ToUntrustedFn>);
const labMemory: LabMemoryReader = { byProject: async () => [] };
const noDrift: DriftReader = { check: async () => [] };
function captureEvents() {
  const sent: Array<EventInput<unknown>> = [];
  return { publish: (e: EventInput<unknown>) => void sent.push(e), sent };
}
const DECISION_JSON = JSON.stringify({ decision: "answer", confidence: 0.7, rationale: "ok", missingInfo: [], risks: [] });

const fakeIdentity = { agentId: "ricky" } as unknown as AgentIdentity;
const advisory = (over: Partial<RuntimeTruthSummary> = {}): RuntimeTruthSummary => ({
  rationale: "advisory rationale", confidence: 0.4,
  risks: ["contradiction (high): A vs B"], missingInfo: ["m-unsupp"], memoryUsed: ["m1", "m2"],
  evidenceNotes: ["evidence coverage 50% of 2 memory(ies)"],
  consistency: { verdict: "INCONSISTENT", confidence: 0.2 },
  health: { memoryCount: 2, overallTrust: 0.5, evidenceCoverage: 0.5, driftScore: 9, driftSeverity: "high" },
  advisoryOnly: true, ...over,
});
const reader = (summary: unknown): RuntimeTruthReaderPort => ({ summarizeForCognition: () => summary as RuntimeTruthSummary });

// ── config resolution ────────────────────────────────────────────────────────

test("disabled by default: no env, non-profile agent → off", () => {
  assert.equal(resolveRuntimeTruthMode("ikbi", {}), "off");
  assert.equal(resolveRuntimeTruthMode(undefined, {}), "off");
  assert.equal(parseRuntimeTruthMode("nonsense"), "off");
  assert.equal(parseRuntimeTruthMode("shadow"), "shadow");
});

test("env IKBI_RUNTIME_TRUTH=shadow enables shadow for all agents", () => {
  assert.equal(resolveRuntimeTruthMode("ikbi", { IKBI_RUNTIME_TRUTH: "shadow" }), "shadow");
});

test("Ricky profile defaults to shadow when env unset; others stay off", () => {
  assert.equal(resolveRuntimeTruthMode("ricky", {}), "shadow");
  assert.equal(resolveRuntimeTruthMode("Ricky", {}), "shadow"); // case-insensitive
  assert.equal(resolveRuntimeTruthMode("bubbles", {}), "off");
  // explicit env off overrides the Ricky default (fail-closed operator control)
  assert.equal(resolveRuntimeTruthMode("ricky", { IKBI_RUNTIME_TRUTH: "off" }), "off");
});

// ── runner behavior ──────────────────────────────────────────────────────────

const decisionRef = { decision: "answer", confidence: 0.7, recommendedModule: null };
const runArgs = (over: Record<string, unknown> = {}) => ({
  mode: "shadow" as const, task: "do the thing", recentRefs: ["m1"], decision: decisionRef,
  agentId: "ricky", identity: fakeIdentity, publish: () => {}, ...over,
});

test("disabled mode → runner is a no-op (no record, no event)", async () => {
  const cap = captureEvents();
  const rec = await runRuntimeTruthShadow(runArgs({ mode: "off", reader: reader(advisory()), publish: cap.publish }));
  assert.equal(rec, null);
  assert.equal(cap.sent.length, 0);
});

test("shadow mode with no reader injected → no-op", async () => {
  const cap = captureEvents();
  const rec = await runRuntimeTruthShadow(runArgs({ publish: cap.publish })); // no reader
  assert.equal(rec, null);
  assert.equal(cap.sent.length, 0);
});

test("shadow mode with reader → record produced + event published", async () => {
  const cap = captureEvents();
  const rec = await runRuntimeTruthShadow(runArgs({ reader: reader(advisory()), publish: cap.publish }));
  assert.ok(rec);
  assert.equal(rec!.advisoryOnly, true);
  assert.equal(rec!.consistencyVerdict, "INCONSISTENT");
  assert.equal(rec!.riskCount, 1);
  assert.equal(rec!.driftSeverity, "high");
  assert.equal(rec!.cognitionDecision, "answer");
  assert.equal(cap.sent.length, 1);
  assert.equal((cap.sent[0] as { type?: string }).type ?? (cap.sent[0] as { name?: string }).name, "cognition.runtime_truth_shadow");
});

test("advisoryOnly=true is ENFORCED: a non-advisory summary is rejected (no record, no event)", async () => {
  for (const bad of [advisory({ advisoryOnly: false as unknown as true }), { ...advisory(), advisoryOnly: undefined }, null, "nope"]) {
    const cap = captureEvents();
    const rec = await runRuntimeTruthShadow(runArgs({ reader: reader(bad), publish: cap.publish }));
    assert.equal(rec, null, "non-advisory summary rejected");
    assert.equal(cap.sent.length, 0);
  }
});

test("a reader that throws is swallowed (shadow never breaks deliberation)", async () => {
  const cap = captureEvents();
  const throwing: RuntimeTruthReaderPort = { summarizeForCognition: () => { throw new Error("boom"); } };
  const rec = await runRuntimeTruthShadow(runArgs({ reader: throwing, publish: cap.publish }));
  assert.equal(rec, null);
  assert.equal(cap.sent.length, 0);
});

test("shadow event carries NO executable action / recommendedNext / approval / install", async () => {
  const cap = captureEvents();
  await runRuntimeTruthShadow(runArgs({ reader: reader(advisory()), publish: cap.publish }));
  const blob = JSON.stringify(cap.sent[0]).toLowerCase();
  for (const forbidden of ["recommendednext", "approve", "install", "execute", "run_", "write_file"]) {
    assert.ok(!blob.includes(forbidden), `shadow event must not contain "${forbidden}"`);
  }
});

// ── cognition integration: NO behavior change ────────────────────────────────

async function deliberateWith(deps: Record<string, unknown>) {
  const layer = createCognitionLayer({ config: CFG, invokeModel: async (_r: ModelRequest) => modelResponse(DECISION_JSON), neutralizeUntrusted: neutralize, toUntrustedMessage: toUntrusted, labMemory, drift: noDrift, ...deps });
  return layer.deliberate({ parentCtx: makeCtx("ricky"), goal: "ship the feature", project: "demo" });
}

test("shadow mode does NOT change the cognition decision result", async () => {
  const cap1 = captureEvents();
  const withoutShadow = await deliberateWith({ publish: cap1.publish }); // mode resolves to shadow (ricky) but NO reader → no-op
  const cap2 = captureEvents();
  const withShadow = await deliberateWith({ publish: cap2.publish, runtimeTruthMode: "shadow", runtimeTruth: reader(advisory()) });
  assert.deepEqual(withShadow, withoutShadow, "decision identical with and without the shadow run");
  assert.equal(withShadow.decision, "answer");
});

test("shadow run alongside cognition emits the shadow event (logged for comparison), decision unchanged", async () => {
  const cap = captureEvents();
  const decision = await deliberateWith({ publish: cap.publish, runtimeTruthMode: "shadow", runtimeTruth: reader(advisory()) });
  const types = cap.sent.map((e) => (e as { type?: string; name?: string }).type ?? (e as { name?: string }).name);
  assert.ok(types.includes("cognition.decided"), "normal cognition event still emitted");
  assert.ok(types.includes("cognition.runtime_truth_shadow"), "shadow comparison event emitted");
  assert.equal(decision.decision, "answer");
});

test("with shadow mode but no injected reader, only the normal cognition event is emitted", async () => {
  const cap = captureEvents();
  await deliberateWith({ publish: cap.publish, runtimeTruthMode: "shadow" }); // no reader
  const types = cap.sent.map((e) => (e as { type?: string; name?: string }).type ?? (e as { name?: string }).name);
  assert.ok(types.includes("cognition.decided"));
  assert.ok(!types.includes("cognition.runtime_truth_shadow"));
});

// ── boundary: ikbi imports the reader PORT only, never Truth Firewall ─────────

test("boundary: runtime-truth-shadow source imports no Truth Firewall and no agent repo", () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const forbidden = [/truth-firewall/, /runtime-truth\/(graph|drift|health|consistency|ledger|reader)/, /ecosystem\//, /pehlichi/, /mad-ptah/, /loony-luna/, /pehlichi-pub/];
  for (const f of files) {
    const importLines = readFileSync(HERE + f, "utf8").split("\n").filter((l) => /\bfrom\s+['"]/.test(l));
    for (const line of importLines) for (const pat of forbidden) assert.ok(!pat.test(line), `${f}: forbidden import "${line.trim()}"`);
  }
});

test("boundary: runtime-truth-shadow performs no file/memory writes", () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of files) {
    const text = readFileSync(HERE + f, "utf8");
    assert.ok(!/from\s+['"](node:)?fs['"]/.test(text), `${f}: must not import fs`);
    assert.ok(!/writeFileSync|appendFileSync|mkdirSync/.test(text), `${f}: no file writes`);
  }
});

test("boundary: cognition.ts consumes runtime-truth-shadow via its public index only, and no Truth Firewall", () => {
  const text = readFileSync(COG, "utf8");
  assert.ok(!/truth-firewall/.test(text), "cognition.ts must not import Truth Firewall");
  const rtImports = text.split("\n").filter((l) => /\bfrom\s+['"][^'"]*runtime-truth-shadow/.test(l));
  assert.ok(rtImports.length > 0, "cognition.ts imports the shadow module");
  for (const line of rtImports) assert.ok(/runtime-truth-shadow\/index\.js/.test(line), `must import the public index, not an internal: ${line.trim()}`);
});
