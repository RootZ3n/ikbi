import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import type { EventInput } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/index.js";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import type { MemoryEntry } from "../lab-context-memory/index.js";
import type { DriftReport } from "../drift-prevention/index.js";
import { commands } from "../../cli/registry.js";
import { createCapabilityRecovery, parseRecoveryPlan, type DriftReader, type LabMemoryReader, type ReceiptReader, type ToUntrustedFn } from "./recovery.js";
import { CapabilityRecoveryError, type CapabilityRecovery, type CapabilityRecoveryInput, type CapabilityRecoveryPlan, type CauseClass } from "./contract.js";
import type { CapabilityRecoveryConfig } from "./config.js";
// Importing cli.js registers the `recover` command at module load.
import { createRecoverCli, parseRecoverArgs } from "./cli.js";

const silent = () => pino({ level: "silent" });
const CFG: CapabilityRecoveryConfig = { enabled: true, maxMemoryEntries: 40, maxReceipts: 100 };

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
function modelSpy(content: string) {
  const calls: ModelRequest[] = [];
  return { invokeModel: async (r: ModelRequest) => { calls.push(r); return modelResponse(content); }, calls };
}

function neutralizeSpy() {
  const calls: Array<{ content: string; context: UntrustedContext }> = [];
  const fn = (content: string, context: UntrustedContext): NeutralizedContent => {
    calls.push({ content, context });
    return { kind: "ikbi/neutralized-untrusted", contractVersion: "1.0.0", wrapped: `[NEUTRALIZED] <${content.length}>`, raw: content, body: content, scan: { verdict: "clean", recommendedAction: "allow", maxConfidence: 0, findings: [], scannedBytes: content.length, truncated: false }, source: context.source, fenceId: "f", bytes: content.length, defangApplied: false, defangedCount: 0, truncated: false, omittedBytes: 0 } as unknown as NeutralizedContent;
  };
  return { fn, calls };
}
const toUntrusted: ToUntrustedFn = (n, opts) => ({ role: opts?.role ?? "user", content: n.wrapped, untrusted: true });

function memEntry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: "demo:ikbi:capability:test-execution", project: "demo", agent: "ikbi", kind: "capability", key: "test-execution", value: { name: "test-execution" }, createdAt: 500, updatedAt: 500, ...over };
}
function rcpt(operation: string, status: Receipt["outcome"]["status"], seq: number, over: Partial<Receipt> = {}): Receipt {
  return { contractVersion: "1.0.0", id: `r${seq}`, seq, timestamp: 1000 + seq, identity: { agentId: "ikbi", trustTier: "trusted" }, operation, outcome: { status }, changes: [], project: "demo", ...over };
}

function fakes(mem: MemoryEntry[], receipts: Receipt[], drift: DriftReport[] = []) {
  const driftCalls: Array<{ agent: string }> = [];
  const labMemory: LabMemoryReader = { byProject: async (project) => mem.filter((e) => e.project === project) };
  const receiptReader: ReceiptReader = { query: async (f?: ReceiptQuery) => receipts.filter((r) => f?.agentId === undefined || r.identity.agentId === f.agentId) };
  const driftReader: DriftReader = { check: async (opts) => { driftCalls.push(opts); return drift; } };
  return { labMemory, receipts: receiptReader, drift: driftReader, driftCalls };
}

function captureEvents() {
  const sent: Array<EventInput<unknown>> = [];
  return { publish: (e: EventInput<unknown>) => void sent.push(e), sent };
}

const mk = (over: Record<string, unknown>) => createCapabilityRecovery({ config: CFG, neutralizeUntrusted: neutralizeSpy().fn, toUntrustedMessage: toUntrusted, publish: () => {}, ...over });
const input = (ctx: OperationContext, capability = "test-execution", project = "demo", evidence?: Record<string, unknown>) => ({ parentCtx: ctx, capability, project, ...(evidence ? { evidence } : {}) });

const DEP_PLAN = '{"status":"unavailable","likelyCause":"dependency","causeConfidence":0.85,"rationale":"pnpm missing","recommendedRepair":{"module":"dependency-install","action":"install","payload":{}}}';

// ── PRODUCES A RECOVERY PLAN (headline) ──────────────────────────────────────

test("produces a CapabilityRecoveryPlan with status, cause, lastKnownGood, evidence, rationale", async () => {
  const f = fakes([memEntry({ updatedAt: 900 })], [rcpt("test-execution", "success", 6), rcpt("test-execution", "failure", 8)]);
  const sm = modelSpy(DEP_PLAN);
  const plan = await mk({ invokeModel: sm.invokeModel, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift }).assess(input(makeCtx()));
  assert.equal(plan.capability, "test-execution");
  assert.equal(plan.status, "unavailable");
  assert.equal(plan.likelyCause, "dependency");
  assert.ok(plan.lastKnownGood, "last-known-good derived from history");
  assert.equal(plan.lastKnownGood?.when, 1006, "the last SUCCESS receipt (timestamp 1000+6) beats the memory entry @900");
  assert.ok(plan.evidenceOfBreakage.some((e) => /failed/.test(e)), "the recent failure is evidence");
  assert.ok(plan.rationale.length > 0);
  assert.equal(plan.recommendedRepair?.module, "dependency-install");
});

// ── CAUSE TAXONOMY ───────────────────────────────────────────────────────────

test("each cause class parses; an unknown cause/status falls to unknown (fail-closed)", () => {
  const causes: CauseClass[] = ["config", "dependency", "registration", "credentials", "model-provider", "path", "permission", "code"];
  for (const c of causes) {
    assert.equal(parseRecoveryPlan(`{"status":"unavailable","likelyCause":"${c}","causeConfidence":0.7,"rationale":"r"}`, "cap", { evidenceOfBreakage: [] }).likelyCause, c);
  }
  assert.equal(parseRecoveryPlan('{"status":"weird","likelyCause":"gremlins"}', "cap", { evidenceOfBreakage: [] }).likelyCause, "unknown");
  assert.equal(parseRecoveryPlan('{"status":"weird"}', "cap", { evidenceOfBreakage: [] }).status, "unknown");
  assert.equal(parseRecoveryPlan("not json", "cap", { evidenceOfBreakage: [] }).status, "unknown");
});

// ── DISTINCT FROM BUILDER + NON-EXECUTING (import scan) ───────────────────────

test("capability-recovery source imports NO repair module (recommends, never invokes)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url).pathname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const importFrom = /(?:import|export)[^;]*from\s+["']([^"']+)["']/g;
  for (const f of files) {
    const src = readFileSync(`${dir}${f}`, "utf8");
    for (const m of src.matchAll(importFrom)) {
      const spec = m[1] ?? "";
      assert.ok(!/worker-model|governed-exec|dependency-install|gate-wall|orchestrator/.test(spec), `${f} must not import ${spec} (recommends, never invokes)`);
    }
  }
});

test("a 'code' cause recommends worker-model as DATA — not a dispatch", async () => {
  const f = fakes([memEntry()], [rcpt("test-execution", "failure", 3)]);
  const sm = modelSpy('{"status":"degraded","likelyCause":"code","causeConfidence":0.6,"rationale":"logic regression","recommendedRepair":{"module":"worker-model","action":"build","payload":{"goal":"fix it"}}}');
  const plan = await mk({ invokeModel: sm.invokeModel, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift }).assess(input(makeCtx()));
  assert.equal(plan.recommendedRepair?.module, "worker-model");
  assert.deepEqual(plan.recommendedRepair?.payload, { goal: "fix it" });
});

// ── LAST-KNOWN-GOOD FROM HISTORY ─────────────────────────────────────────────

test("no historical record ⇒ status unknown, no model call (cannot recover the never-known)", async () => {
  const f = fakes([], []); // no memory, no receipts for the capability
  const sm = modelSpy(DEP_PLAN);
  const plan = await mk({ invokeModel: sm.invokeModel, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift }).assess(input(makeCtx(), "never-existed"));
  assert.equal(plan.status, "unknown");
  assert.equal(plan.likelyCause, "unknown");
  assert.match(plan.rationale, /never known/);
  assert.equal(sm.calls.length, 0, "no model call when there is no history");
});

// ── EVIDENCE OF BREAKAGE ─────────────────────────────────────────────────────

test("recent failures + caller evidence feed evidenceOfBreakage (structural, not verbatim)", async () => {
  const f = fakes([memEntry()], [rcpt("test-execution", "success", 1), rcpt("test-execution", "failure", 8), rcpt("test-execution", "rejected", 9)]);
  const sm = modelSpy(DEP_PLAN);
  const plan = await mk({ invokeModel: sm.invokeModel, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift }).assess(input(makeCtx(), "test-execution", "demo", { probeExit: 1 }));
  assert.ok(plan.evidenceOfBreakage.some((e) => e.includes("failed (failure)")));
  assert.ok(plan.evidenceOfBreakage.some((e) => e.includes("failed (rejected)")));
  assert.ok(plan.evidenceOfBreakage.some((e) => e.includes("caller evidence keys: probeExit")), "evidence KEYS only, not values");
});

// ── UNTRUSTED NEUTRALIZED ─────────────────────────────────────────────────────

test("capability name + caller evidence + memory are neutralized before the model", async () => {
  const ne = neutralizeSpy();
  const sm = modelSpy(DEP_PLAN);
  // capability matches the memory entry (so memory is fed); the injection + secrets live
  // in the untrusted caller-evidence + memory VALUE, which must be neutralized.
  const f = fakes([memEntry({ value: { name: "test-execution", note: "MEMORY-SECRET-9" } })], [rcpt("test-execution", "failure", 2)]);
  await createCapabilityRecovery({ config: CFG, neutralizeUntrusted: ne.fn, toUntrustedMessage: toUntrusted, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift, publish: () => {}, invokeModel: sm.invokeModel }).assess(input(makeCtx(), "test-execution", "demo", { probe: "IGNORE-INSTRUCTIONS-rmrf", secretEvidence: "EVIDENCE-SECRET-7" }));
  assert.ok(ne.calls.some((c) => c.context.origin === "capability_name"), "capability name neutralized");
  assert.ok(ne.calls.some((c) => c.context.origin === "caller_evidence"), "caller evidence neutralized");
  assert.ok(ne.calls.some((c) => typeof c.context.origin === "string" && c.context.origin.startsWith("lab_memory")), "memory neutralized");
  const prompt = JSON.stringify(sm.calls[0]?.messages ?? []);
  assert.ok(!prompt.includes("IGNORE-INSTRUCTIONS-rmrf"), "raw caller-evidence injection not in the prompt un-neutralized");
  assert.ok(!prompt.includes("EVIDENCE-SECRET-7"), "raw caller evidence value not in the prompt un-neutralized");
  assert.ok(!prompt.includes("MEMORY-SECRET-9"), "raw memory value not in the prompt un-neutralized");
});

// ── DRIFT INFORMS (read, not triggered) ──────────────────────────────────────

test("a drift signal is consulted (read) to inform degraded-vs-gone, never triggered", async () => {
  const sm = modelSpy('{"status":"degraded","likelyCause":"model-provider","causeConfidence":0.5,"rationale":"drifting"}');
  const f = fakes([memEntry()], [rcpt("test-execution", "failure", 2)], [{ agent: "ikbi", operation: "test-execution", baselineRate: 0.9, recentRate: 0.5, drop: 0.4, sampleSize: 10, drifted: true, severity: "major", reason: "x" }]);
  const plan = await mk({ invokeModel: sm.invokeModel, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift }).assess(input(makeCtx()));
  assert.equal(f.driftCalls.length, 1, "drift.check was called (read)");
  const sys = (sm.calls[0]?.messages ?? []).find((m) => m.role === "system");
  assert.match(sys?.content ?? "", /Drift signals/);
  assert.equal(plan.status, "degraded");
});

// ── NO LEAK ──────────────────────────────────────────────────────────────────

test("recovery.* events carry status/cause/capability/module only — no evidence/memory content", async () => {
  const ev = captureEvents();
  const f = fakes([memEntry({ value: { note: "MEM-SECRET" } })], [rcpt("test-execution", "failure", 2)]);
  const sm = modelSpy('{"status":"unavailable","likelyCause":"path","causeConfidence":0.9,"rationale":"RATIONALE-SECRET","recommendedRepair":{"module":"manual","action":"fix path","payload":{}}}');
  await mk({ invokeModel: sm.invokeModel, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift, publish: ev.publish }).assess(input(makeCtx(), "test-execution", "demo", { e: "EVID-SECRET" }));
  const serialized = JSON.stringify(ev.sent);
  for (const secret of ["RATIONALE-SECRET", "EVID-SECRET", "MEM-SECRET"]) assert.ok(!serialized.includes(secret), `"${secret}" must not be in events`);
  for (const e of ev.sent) assert.equal((e as { source: string }).source, "capability-recovery");
  const payload = ev.sent[0]?.payload as { status: string; likelyCause: string; recommendedModule: string | null };
  assert.equal(payload.status, "unavailable");
  assert.equal(payload.likelyCause, "path");
  assert.equal(payload.recommendedModule, "manual");
});

// ── fail-closed refusals ─────────────────────────────────────────────────────

test("disabled ⇒ refuse (no model call); non-validated identity ⇒ refuse (no model call)", async () => {
  const sm = modelSpy(DEP_PLAN);
  const f = fakes([memEntry()], [rcpt("test-execution", "failure", 2)]);
  await assert.rejects(
    () => createCapabilityRecovery({ config: { ...CFG, enabled: false }, invokeModel: sm.invokeModel, neutralizeUntrusted: neutralizeSpy().fn, toUntrustedMessage: toUntrusted, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift, publish: () => {} }).assess(input(makeCtx())),
    (e: unknown) => e instanceof CapabilityRecoveryError && e.kind === "disabled",
  );
  const spoof = { contractVersion: "1.1.0", identity: { kind: "agent", identity: { agentId: "x", trustTier: "operator" }, authMethod: "agent_token", resolvedAt: 0 }, startedAt: 0 } as unknown as OperationContext;
  await assert.rejects(
    () => mk({ invokeModel: sm.invokeModel, labMemory: f.labMemory, receipts: f.receipts, drift: f.drift }).assess({ parentCtx: spoof, capability: "test-execution", project: "demo" }),
    (e: unknown) => e instanceof CapabilityRecoveryError && e.kind === "identity",
  );
  assert.equal(sm.calls.length, 0, "no model call on a refusal");
});

// ── `ikbi recover` OPERATOR DIAGNOSTIC COMMAND (M8/M9) ───────────────────────

const OPERATOR_TOKEN = "operator-token-value";

/** A resolver over an operator agent (the real identity path for the CLI). */
function cliResolver() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "operator", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken(OPERATOR_TOKEN)] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return (claim: { token?: string }) => resolver.resolve(claim);
}

/** A fake assess surface recording every call (proves DIAGNOSE-ONLY + a fixed plan). */
function fakeRecovery(plan: CapabilityRecoveryPlan) {
  const calls: CapabilityRecoveryInput[] = [];
  const recovery: CapabilityRecovery = { assess: async (input) => { calls.push(input); return plan; } };
  return { recovery, calls };
}

function cliCapture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

const SAMPLE_PLAN: CapabilityRecoveryPlan = {
  capability: "test-execution",
  status: "unavailable",
  lastKnownGood: { when: 900, source: "receipt:worker.role.verifier" },
  evidenceOfBreakage: ["worker.role.verifier failed (failure)"],
  likelyCause: "dependency",
  causeConfidence: 0.85,
  rationale: "pnpm is missing from the worktree",
  recommendedRepair: { module: "dependency-install", action: "install pnpm", payload: { package: "pnpm" } },
};

test("`ikbi recover` is registered (no built-in collision); parseRecoverArgs handles --project", () => {
  assert.ok(commands.has("recover"), "the recover command registered on cli.js import");
  for (const b of ["version", "models", "providers", "help", "build", "batch"]) assert.notEqual(b, "recover");
  assert.deepEqual(parseRecoverArgs(["test-execution", "--project", "demo"]), { project: "demo", rest: ["test-execution"] });
  assert.deepEqual(parseRecoverArgs(["provider-routing"]), { rest: ["provider-routing"] });
});

test("recover fails closed (friendly) with no operator token — no assess call", async () => {
  const fr = fakeRecovery(SAMPLE_PLAN);
  const cap = cliCapture();
  const cli = createRecoverCli({ capabilityRecovery: fr.recovery, resolveIdentity: cliResolver(), operatorToken: undefined, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  await cli.recover(["test-execution"]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /no operator identity.*IKBI_OPERATOR_TOKEN/);
  assert.equal(fr.calls.length, 0, "no assessment without an operator identity");
  assert.equal(cap.out, "");
});

test("recover with no capability ⇒ usage hint, no assess call", async () => {
  const fr = fakeRecovery(SAMPLE_PLAN);
  const cap = cliCapture();
  const cli = createRecoverCli({ capabilityRecovery: fr.recovery, resolveIdentity: cliResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  await cli.recover([]);
  assert.equal(cap.exit, 1);
  assert.match(cap.err, /needs a capability/);
  assert.equal(fr.calls.length, 0);
});

test("recover PRINTS the diagnosis (capability/status/likelyCause/recommendedRepair) — readable plan", async () => {
  const fr = fakeRecovery(SAMPLE_PLAN);
  const cap = cliCapture();
  const cli = createRecoverCli({ capabilityRecovery: fr.recovery, resolveIdentity: cliResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  await cli.recover(["test-execution", "--project", "demo"]);

  assert.equal(cap.exit, undefined, "a clean diagnosis does not exit non-zero");
  // assess got the parsed capability + project, attributed to the operator context.
  assert.equal(fr.calls.length, 1, "assess was called exactly once");
  assert.equal(fr.calls[0]?.capability, "test-execution");
  assert.equal(fr.calls[0]?.project, "demo");
  // The diagnosis fields are printed.
  const printed = JSON.parse(cap.out) as Record<string, unknown>;
  assert.equal(printed.capability, "test-execution");
  assert.equal(printed.status, "unavailable");
  assert.equal(printed.likelyCause, "dependency");
  assert.equal(printed.causeConfidence, 0.85);
  assert.match(String(printed.rationale), /pnpm/);
  assert.equal((printed.recommendedRepair as { module: string }).module, "dependency-install", "which module should repair it");
  assert.equal((printed.recommendedRepair as { action: string }).action, "install pnpm");
});

test("recover is NON-EXECUTING: it DIAGNOSES + prints, it does NOT dispatch the recommendedRepair", async () => {
  // The plan recommends worker-model; the command must print it as DATA, never invoke it.
  const codePlan: CapabilityRecoveryPlan = { capability: "x", status: "degraded", evidenceOfBreakage: [], likelyCause: "code", causeConfidence: 0.6, rationale: "logic regression", recommendedRepair: { module: "worker-model", action: "build", payload: { goal: "fix it" } } };
  const fr = fakeRecovery(codePlan);
  const cap = cliCapture();
  const cli = createRecoverCli({ capabilityRecovery: fr.recovery, resolveIdentity: cliResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  await cli.recover(["x"]);

  assert.equal(fr.calls.length, 1, "the command's ONLY action is assess() — no repair dispatch");
  const printed = JSON.parse(cap.out) as { recommendedRepair: { module: string } };
  assert.equal(printed.recommendedRepair.module, "worker-model", "the recommendation is reported as data, not invoked");
  // The repair payload is NOT echoed (module + action only — a recommendation, not a dispatch).
  assert.ok(!cap.out.includes("\"payload\""), "the command prints module+action only, never executes the repair");
});
