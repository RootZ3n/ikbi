import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import type { EventInput } from "../../core/events/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ModelMessage, ModelRequest, ModelResponse, ToolCall } from "../../core/provider/contract.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/index.js";
import type { PromoteGovernance } from "../../core/workspace/contract.js";
import { createGateWall, type GateWall, type GateWallEvaluateInput } from "../gate-wall/index.js";
import { createMcpModelLoop } from "./loop.js";
import type { McpToolDef, McpTransport } from "./contract.js";
import type { McpEventPayload } from "./events.js";

const silent = () => pino({ level: "silent" });

/** A validated operation context for a caller at the given tier. */
function makeCtx(tier: string): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "caller-1", kind: "agent", defaultTrustTier: tier, tokenHashes: [hashToken("caller-secret")] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "caller-secret" }), { requestId: "req-1" });
}

const cfg = { enabled: true, maxToolIterations: 20, loopTimeoutMs: 60_000 };

/** A model response builder. */
function modelResponse(over: Partial<ModelResponse> = {}): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    content: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [], ...over,
  };
}

function toolCall(name: string, args: string, id = "tc-1"): ToolCall {
  return { id, name, arguments: args };
}

/** A scripted model: returns each queued response in turn, then a final "stop". */
function scriptedModel(queue: ModelResponse[]) {
  const calls: ModelRequest[] = [];
  let i = 0;
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    calls.push(req);
    return queue[i++] ?? modelResponse({ content: "final", finishReason: "stop" });
  };
  return { invokeModel, calls };
}

/** A transport that records connect/listTools/callTool/close + serves canned results. */
function fakeTransport(result = "RAW-TOOL-RESULT", tools?: McpToolDef[]) {
  const events: string[] = [];
  const callToolArgs: Array<{ name: string; argsJson: string }> = [];
  const transport: McpTransport = {
    connect: async () => void events.push("connect"),
    listTools: async () => {
      events.push("listTools");
      return tools ?? [{ name: "search", description: "search", parameters: { type: "object", properties: {} } }];
    },
    callTool: async (name, argsJson) => {
      events.push("callTool");
      callToolArgs.push({ name, argsJson });
      return result;
    },
    close: async () => void events.push("close"),
  };
  return { transport, events, callToolArgs };
}

/** A neutralize spy with the core-compatible signature (wraps raw in a marker). */
function neutralizeSpy() {
  const calls: Array<{ content: string; context: UntrustedContext }> = [];
  const fn = (content: string, context: UntrustedContext): NeutralizedContent => {
    calls.push({ content, context });
    return {
      kind: "ikbi/neutralized-untrusted",
      contractVersion: "1.0.0",
      wrapped: `[NEUTRALIZED:${context.source}] <redacted ${content.length} chars>`,
      raw: content,
      body: content,
      scan: { verdict: "clean", recommendedAction: "allow", maxConfidence: 0, findings: [], scannedBytes: content.length, truncated: false },
      source: context.source,
      ...(context.origin !== undefined ? { origin: context.origin } : {}),
      fenceId: "fence-1",
      bytes: content.length,
      defangApplied: false,
      defangedCount: 0,
      truncated: false,
      omittedBytes: 0,
    } as unknown as NeutralizedContent;
  };
  return { fn, calls };
}

/** The to-untrusted-message wrapper (core-compatible): wraps the neutralized form. */
const toUntrusted = (n: NeutralizedContent, opts?: { role?: "user" | "tool"; toolCallId?: string }): ModelMessage => ({
  role: opts?.role ?? "user",
  content: n.wrapped,
  untrusted: true,
  ...(opts?.toolCallId !== undefined ? { toolCallId: opts.toolCallId } : {}),
});

/** A gate that delegates to the REAL gate-wall and captures inputs. */
function capturingGate() {
  const real = createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} });
  const inputs: GateWallEvaluateInput[] = [];
  const order: string[] = [];
  const gateWall: GateWall = {
    evaluate: async (input) => {
      inputs.push(input);
      order.push("gate");
      return real.evaluate(input);
    },
  };
  return { gateWall, inputs, order };
}

/** A gate that always denies (session AND tool calls). */
function denyingGate() {
  const inputs: GateWallEvaluateInput[] = [];
  const gateWall: GateWall = {
    evaluate: async (input): Promise<PromoteGovernance> => {
      inputs.push(input);
      return { allow: false, reason: "denied by test policy", gateId: "g1" };
    },
  };
  return { gateWall, inputs };
}

/** A gate that ALLOWS the session (mcp.connect) but DENIES every tool call. */
function sessionAllowToolDenyGate() {
  const inputs: GateWallEvaluateInput[] = [];
  const gateWall: GateWall = {
    evaluate: async (input): Promise<PromoteGovernance> => {
      inputs.push(input);
      const isSession = input.action.kind === "exec" && input.action.command === "mcp.connect";
      return isSession ? { allow: true, reason: "session ok", gateId: "gs" } : { allow: false, reason: "denied by test policy", gateId: "g1" };
    },
  };
  return { gateWall, inputs };
}

function captureEvents() {
  const sent: Array<EventInput<McpEventPayload>> = [];
  return { publish: (e: EventInput<McpEventPayload>) => void sent.push(e), sent, types: () => sent.map((e) => e.type) };
}

function baseDeps(over: Record<string, unknown>) {
  const ne = neutralizeSpy();
  return {
    deps: { config: cfg, neutralizeUntrusted: ne.fn, toUntrustedMessage: toUntrusted, publish: () => {}, ...over },
    neutralize: ne,
  };
}

// ── INVARIANT 1: INBOUND NEUTRALIZE (#8) ─────────────────────────────────────

test("every MCP tool result is neutralized inbound (source mcp_result); no raw path into the conversation", async () => {
  const tp = fakeTransport("SECRET-TOOL-OUTPUT-XYZ");
  const sm = scriptedModel([modelResponse({ content: "calling", finishReason: "tool_calls", toolCalls: [toolCall("search", "{}")] })]);
  const gate = capturingGate();
  const { deps, neutralize } = baseDeps({ transport: tp.transport, invokeModel: sm.invokeModel, gateWall: gate.gateWall });
  const loop = createMcpModelLoop(deps);

  const r = await loop.run({ parentCtx: makeCtx("verified"), goal: "find it" });
  assert.equal(r.neutralizedCount, 1, "the one tool result was neutralized once");
  assert.equal(neutralize.calls.length, 1);
  assert.equal(neutralize.calls[0]?.context.source, "mcp_result", "neutralized as an MCP result (#8)");
  assert.equal(neutralize.calls[0]?.context.origin, "search");

  // The raw tool output never enters the conversation as a raw tool message — only
  // the neutralized form is appended. The second model call sees the wrapped form.
  const secondCallMessages = sm.calls[1]?.messages ?? [];
  const toolMsg = secondCallMessages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "a tool message was appended");
  assert.equal(toolMsg?.untrusted, true, "the tool message is marked untrusted");
  assert.ok(!toolMsg?.content.includes("SECRET-TOOL-OUTPUT-XYZ"), "raw output is NOT present; only the neutralized wrap");
  assert.ok(toolMsg?.content.includes("NEUTRALIZED"));
});

// ── INVARIANT 2: OUTBOUND GATE ───────────────────────────────────────────────

test("every tool call is gated (kind:exec) BEFORE the transport is touched", async () => {
  const tp = fakeTransport();
  const sm = scriptedModel([modelResponse({ finishReason: "tool_calls", toolCalls: [toolCall("search", '{"q":"x"}')] })]);
  const gate = capturingGate();
  const { deps } = baseDeps({ transport: tp.transport, invokeModel: sm.invokeModel, gateWall: gate.gateWall });
  const loop = createMcpModelLoop(deps);

  const r = await loop.run({ parentCtx: makeCtx("verified"), goal: "g" });
  // TWO gates now: the SESSION gate (mcp.connect) first, then the per-tool-call gate.
  assert.equal(gate.inputs.length, 2, "session gate + per-call gate");
  const a0 = gate.inputs[0]?.action;
  assert.equal(a0?.kind === "exec" ? a0.command : undefined, "mcp.connect", "the SESSION is gated FIRST, before any transport call");
  const toolGate = gate.inputs.find((i) => i.action.kind === "exec" && i.action.command === "search");
  assert.ok(toolGate, "the tool call is also gated (kind:exec, command=search)");
  assert.equal(r.gatedCalls, 1, "gatedCalls counts tool calls (the session gate is separate)");
  assert.equal(tp.events.includes("callTool"), true, "an allowed call reached the transport");
  // gate happened before the transport call.
  assert.ok(tp.events.indexOf("callTool") > tp.events.indexOf("listTools"));
});

test("a denying per-call gate REFUSES the call: transport.callTool NEVER invoked; denial fed back neutralized", async () => {
  // The SESSION is allowed (so connect/listTools/loop proceed) but each tool call is denied.
  const tp = fakeTransport();
  const sm = scriptedModel([modelResponse({ finishReason: "tool_calls", toolCalls: [toolCall("search", "{}")] })]);
  const gate = sessionAllowToolDenyGate();
  const { deps, neutralize } = baseDeps({ transport: tp.transport, invokeModel: sm.invokeModel, gateWall: gate.gateWall });
  const loop = createMcpModelLoop(deps);

  const r = await loop.run({ parentCtx: makeCtx("verified"), goal: "g" });
  assert.equal(r.deniedCalls, 1);
  assert.ok(tp.events.includes("connect"), "the session was allowed, so connect happened");
  assert.equal(tp.callToolArgs.length, 0, "the transport was NEVER invoked for a denied call");
  assert.ok(!tp.events.includes("callTool"));
  // The denial is fed back THROUGH the neutralize chokepoint (still untrusted).
  assert.equal(neutralize.calls.length, 1, "the denial result was neutralized like any tool result");
  assert.match(neutralize.calls[0]?.content ?? "", /DENIED by policy/);
});

// ── INVARIANT 2b: SESSION GATE (Codex blocker fix) ───────────────────────────

test("SESSION GATE: a denying gate refuses the session — transport NEVER touched (no connect/listTools/callTool)", async () => {
  const tp = fakeTransport();
  const sm = scriptedModel([modelResponse({ finishReason: "tool_calls", toolCalls: [toolCall("search", "{}")] })]);
  const gate = denyingGate();
  const { deps, neutralize } = baseDeps({ transport: tp.transport, invokeModel: sm.invokeModel, gateWall: gate.gateWall });
  const loop = createMcpModelLoop(deps);

  const r = await loop.run({ parentCtx: makeCtx("verified"), goal: "g" });
  assert.equal(r.completed, false);
  assert.equal(r.stopReason, "gate_denied");
  assert.match(r.reason ?? "", /session denied/);
  // THE FIX: no transport call without a preceding allow — connect/listTools/callTool all skipped.
  assert.equal(tp.events.length, 0, "transport NEVER touched (no connect, no listTools, no close)");
  assert.equal(tp.callToolArgs.length, 0);
  assert.equal(sm.calls.length, 0, "the model was never invoked");
  assert.equal(neutralize.calls.length, 0, "nothing to neutralize");
  // Exactly ONE gate call — the session gate — and it denied.
  assert.equal(gate.inputs.length, 1, "only the session gate ran");
  const a = gate.inputs[0]?.action;
  assert.equal(a?.kind === "exec" ? a.command : undefined, "mcp.connect");
});

// ── bounded loop ─────────────────────────────────────────────────────────────

test("a model that always asks for tools terminates at MAX_TOOL_ITERATIONS (not infinite)", async () => {
  const tp = fakeTransport();
  // invokeModel ALWAYS returns tool_calls — the loop must self-bound.
  const always = async (): Promise<ModelResponse> => modelResponse({ finishReason: "tool_calls", toolCalls: [toolCall("search", "{}")] });
  const gate = capturingGate();
  const { deps } = baseDeps({ transport: tp.transport, invokeModel: always, gateWall: gate.gateWall, config: { ...cfg, maxToolIterations: 3 } });
  const loop = createMcpModelLoop(deps);

  const r = await loop.run({ parentCtx: makeCtx("verified"), goal: "g" });
  assert.equal(r.stopReason, "max_iterations");
  assert.equal(r.rounds, 3, "bounded at the cap");
  assert.equal(r.completed, false);
});

// ── identity threading ───────────────────────────────────────────────────────

test("every invokeModel carries the SAME identity by reference across rounds", async () => {
  const tp = fakeTransport();
  const sm = scriptedModel([
    modelResponse({ finishReason: "tool_calls", toolCalls: [toolCall("search", "{}")] }),
    modelResponse({ finishReason: "tool_calls", toolCalls: [toolCall("search", "{}", "tc-2")] }),
    modelResponse({ content: "ok", finishReason: "stop" }),
  ]);
  const gate = capturingGate();
  const { deps } = baseDeps({ transport: tp.transport, invokeModel: sm.invokeModel, gateWall: gate.gateWall });
  const loop = createMcpModelLoop(deps);

  await loop.run({ parentCtx: makeCtx("verified"), goal: "g" });
  assert.ok(sm.calls.length >= 3);
  const first = sm.calls[0]?.identity;
  assert.equal(first?.agentId, "caller-1");
  for (const c of sm.calls) assert.equal(c.identity, first, "same identity object every round (reference equality)");
});

// ── fail-closed refusals ─────────────────────────────────────────────────────

test("a disabled loop refuses: no transport, no invokeModel", async () => {
  const tp = fakeTransport();
  const sm = scriptedModel([]);
  const gate = capturingGate();
  const { deps } = baseDeps({ transport: tp.transport, invokeModel: sm.invokeModel, gateWall: gate.gateWall, config: { ...cfg, enabled: false } });
  const loop = createMcpModelLoop(deps);

  const r = await loop.run({ parentCtx: makeCtx("verified"), goal: "g" });
  assert.equal(r.completed, false);
  assert.match(r.reason ?? "", /disabled/);
  assert.equal(tp.events.length, 0, "the transport was never touched");
  assert.equal(sm.calls.length, 0, "the model was never invoked");
});

test("a non-validated identity is refused: no transport, no invokeModel", async () => {
  const tp = fakeTransport();
  const sm = scriptedModel([]);
  const { deps } = baseDeps({ transport: tp.transport, invokeModel: sm.invokeModel, gateWall: capturingGate().gateWall });
  const loop = createMcpModelLoop(deps);

  const spoof = {
    contractVersion: "1.1.0",
    identity: { kind: "agent", identity: { agentId: "spoof", trustTier: "operator" }, authMethod: "agent_token", resolvedAt: 0 },
    startedAt: 0,
  } as unknown as OperationContext;
  const r = await loop.run({ parentCtx: spoof, goal: "g" });
  assert.equal(r.completed, false);
  assert.match(r.reason ?? "", /validated identity/);
  assert.equal(tp.events.length, 0);
  assert.equal(sm.calls.length, 0);
});

// ── transport lifecycle ──────────────────────────────────────────────────────

test("transport connects before the loop and closes after — even on a mid-loop break", async () => {
  const tp = fakeTransport();
  // A model that asks for tools then breaks at the cap → mid-loop termination path.
  const always = async (): Promise<ModelResponse> => modelResponse({ finishReason: "tool_calls", toolCalls: [toolCall("search", "{}")] });
  const { deps } = baseDeps({ transport: tp.transport, invokeModel: always, gateWall: capturingGate().gateWall, config: { ...cfg, maxToolIterations: 2 } });
  const loop = createMcpModelLoop(deps);

  await loop.run({ parentCtx: makeCtx("verified"), goal: "g" });
  assert.equal(tp.events[0], "connect", "connect first");
  assert.equal(tp.events.at(-1), "close", "close last (not skipped by the mid-loop break)");
});

// ── no leak ──────────────────────────────────────────────────────────────────

test("events never carry full tool args or raw results", async () => {
  const tp = fakeTransport("RAW-RESULT-SECRET-9");
  const sm = scriptedModel([modelResponse({ finishReason: "tool_calls", toolCalls: [toolCall("search", '{"q":"ARG-SECRET-8"}')] })]);
  const ev = captureEvents();
  const ne = neutralizeSpy();
  const loop = createMcpModelLoop({
    config: cfg,
    transport: tp.transport,
    invokeModel: sm.invokeModel,
    gateWall: capturingGate().gateWall,
    neutralizeUntrusted: ne.fn,
    toUntrustedMessage: toUntrusted,
    publish: ev.publish,
  });

  await loop.run({ parentCtx: makeCtx("verified"), goal: "g" });
  for (const e of ev.sent) assert.equal(e.source, "mcp-model-loop");
  assert.ok(ev.types().includes("mcp.loop.started"));
  assert.ok(ev.types().includes("mcp.tool.gated"));
  const serialized = JSON.stringify(ev.sent);
  assert.ok(!serialized.includes("ARG-SECRET-8"), "full tool args are NOT in events");
  assert.ok(!serialized.includes("RAW-RESULT-SECRET-9"), "raw tool results are NOT in events");
});
