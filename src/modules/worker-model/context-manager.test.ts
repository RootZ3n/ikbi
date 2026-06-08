import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity, ModelMessage, ModelResponse, ToolCall } from "../../core/provider/contract.js";
import type { ModelCapabilities } from "../../core/provider/capabilities.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { TrustTier } from "../../core/identity/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import { createBuilder } from "./builder.js";
import type { RoleContext, RoleEngine } from "./contract.js";
import { estimateTokens, maybeCompress } from "./context-manager.js";

const IDENTITY: AgentIdentity = { agentId: "w", functionalRole: "builder", trustTier: "verified", spawnedFrom: "p" };
const TINY: ModelCapabilities = { context_window: 100, supports_tools: true, reasoning_level: "low", speed_class: "fast" };
const HUGE: ModelCapabilities = { context_window: 1_000_000, supports_tools: true, reasoning_level: "high", speed_class: "fast" };

const msg = (role: ModelMessage["role"], content: string, toolCallId?: string): ModelMessage =>
  ({ role, content, ...(toolCallId !== undefined ? { toolCallId } : {}) });

/** A summarizing invoke that returns a fixed summary, recording how many times it ran. */
function summarizer(summary = "SUMMARY-OF-MIDDLE") {
  let calls = 0;
  const invoke = async (): Promise<ModelResponse> => {
    calls += 1;
    return {
      contractVersion: "1.1.0", model: "m", provider: "p", providerModelId: "m", content: summary, finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
      latencyMs: 1, fellBack: false, attempts: [],
    };
  };
  return { invoke: invoke as unknown as Parameters<typeof maybeCompress>[2]["invoke"], get calls() { return calls; } };
}

const deps = (invoke: Parameters<typeof maybeCompress>[2]["invoke"]) => ({
  invoke,
  model: "m",
  identity: IDENTITY,
  wrapSummary: (text: string): ModelMessage => ({ role: "user", content: text }),
});

// ── estimateTokens ──────────────────────────────────────────────────────────

test("estimateTokens grows roughly with content length", () => {
  const small = estimateTokens([msg("user", "x".repeat(8))]);
  const big = estimateTokens([msg("user", "x".repeat(800))]);
  assert.ok(big > small);
  assert.ok(big >= 200, "≈ 800/4 tokens");
});

// ── maybeCompress ─────────────────────────────────────────────────────────────

test("maybeCompress is a no-op well under the threshold", async () => {
  const messages = [msg("system", "s"), msg("user", "a"), msg("user", "b"), msg("user", "c"), msg("assistant", "d"), msg("user", "e")];
  const r = await maybeCompress(messages, HUGE, deps(summarizer().invoke));
  assert.equal(r.compressed, false);
  assert.equal(messages.length, 6, "untouched");
});

test("maybeCompress compresses the middle, preserving header + recent tail", async () => {
  const header = [msg("system", "SYS"), msg("user", "GOAL"), msg("user", "SUCCESS"), msg("user", "PRIOR")];
  const middle = Array.from({ length: 10 }, (_, i) => msg(i % 2 === 0 ? "assistant" : "user", `middle-${i} ${"x".repeat(20)}`));
  const tail = Array.from({ length: 6 }, (_, i) => msg("user", `tail-${i}`));
  const messages = [...header, ...middle, ...tail];
  const before = messages.length;

  const sum = summarizer();
  const r = await maybeCompress(messages, TINY, deps(sum.invoke));

  assert.equal(r.compressed, true);
  assert.equal(sum.calls, 1, "summarized once");
  assert.equal(messages.length, before - middle.length + 1, "middle collapsed to one summary message");
  // Header preserved verbatim.
  assert.deepEqual(messages.slice(0, 4).map((m) => m.content), ["SYS", "GOAL", "SUCCESS", "PRIOR"]);
  // The summary sits right after the header.
  assert.match(messages[4]!.content, /SUMMARY-OF-MIDDLE/);
  assert.match(messages[4]!.content, /COMPRESSED SUMMARY of 10/);
  // The recent tail is preserved verbatim.
  assert.deepEqual(messages.slice(5).map((m) => m.content), tail.map((m) => m.content));
  assert.ok((r.after ?? 0) < (r.before ?? Infinity), "estimate dropped");
});

test("maybeCompress never lets the kept tail begin with an orphaned tool result", async () => {
  const header = [msg("system", "S"), msg("user", "G"), msg("user", "C"), msg("user", "P")];
  const middle = Array.from({ length: 8 }, (_, i) => msg("assistant", `m${i} ${"y".repeat(10)}`));
  // The message exactly at the default tail boundary is a TOOL result (would be orphaned).
  const boundaryTool = msg("tool", "orphan tool output", "tc1");
  const tail = [boundaryTool, ...Array.from({ length: 5 }, (_, i) => msg("user", `t${i}`))];
  const messages = [...header, ...middle, ...tail];

  await maybeCompress(messages, TINY, deps(summarizer().invoke));
  // The first message after the summary (the new tail start) must NOT be a tool result.
  assert.notEqual(messages[5]?.role, "tool", "the orphan tool was pulled into the compressed middle");
});

test("maybeCompress never fails the build — a summarizer error leaves messages untouched", async () => {
  const header = [msg("system", "S"), msg("user", "G"), msg("user", "C"), msg("user", "P")];
  const middle = Array.from({ length: 10 }, (_, i) => msg("assistant", `m${i} ${"z".repeat(20)}`));
  const tail = Array.from({ length: 6 }, (_, i) => msg("user", `t${i}`));
  const messages = [...header, ...middle, ...tail];
  const before = messages.length;

  const throwing = (async () => { throw new Error("boom"); }) as unknown as Parameters<typeof maybeCompress>[2]["invoke"];
  const r = await maybeCompress(messages, TINY, deps(throwing));
  assert.equal(r.compressed, false);
  assert.equal(messages.length, before, "untouched on summarizer failure");
});

test("maybeCompress LOGS the summarizer error at warn level (visibility, not silence)", async () => {
  const header = [msg("system", "S"), msg("user", "G"), msg("user", "C"), msg("user", "P")];
  const middle = Array.from({ length: 10 }, (_, i) => msg("assistant", `m${i} ${"z".repeat(20)}`));
  const tail = Array.from({ length: 6 }, (_, i) => msg("user", `t${i}`));
  const messages = [...header, ...middle, ...tail];

  const warned: string[] = [];
  const throwing = (async () => { throw new Error("provider exploded"); }) as unknown as Parameters<typeof maybeCompress>[2]["invoke"];
  const r = await maybeCompress(messages, TINY, { ...deps(throwing), logger: { warn: (m: string) => void warned.push(m) } });

  assert.equal(r.compressed, false, "still returns compressed:false (behavior unchanged)");
  assert.equal(warned.length, 1, "the failure was logged exactly once");
  assert.match(warned[0] ?? "", /\[compress\] summarization failed: provider exploded/);
});

// ── builder integration: compaction triggers with a small-window model ───────

const PARENT_CTX: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }), now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
})();
const greenExec = () => ({ run: async (_req: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) });

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "llama-test", provider: "p", providerModelId: "llama-test",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const toolResp = (calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-ctxmgr-"));

test("builder: compaction triggers under a small-window model once the conversation grows", async () => {
  const dir = tmp();
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: "verified", spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = {
    id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: dir, identity, state: "allocated" as const, createdAt: 0,
  };

  // The builder fills the context by writing big files; the summarizer call is detected by its
  // system prompt and answered separately (so it doesn't consume the main tool script).
  let step = 0;
  const big = "Q".repeat(9_000);
  // Enough write rounds that the message COUNT (not just token estimate) exceeds the
  // header + keepRecent + min-middle floor, so a compaction can actually run.
  const mainScript: ModelResponse[] = [
    toolResp([call("write_file", { path: "f1.ts", content: big })]),
    toolResp([call("write_file", { path: "f2.ts", content: big })]),
    toolResp([call("write_file", { path: "f3.ts", content: big })]),
    toolResp([call("write_file", { path: "f4.ts", content: big })]),
    toolResp([call("write_file", { path: "f5.ts", content: big })]),
    ({ ...base(), content: "", finishReason: "length" }),
  ];
  const engine: RoleEngine = {
    invokeModel: async (req) => {
      const sys = (req.messages ?? []).find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("compacting an in-progress automated BUILD")) {
        return { ...base(), content: "compressed summary of earlier writes", finishReason: "stop" };
      }
      const r = mainScript[Math.min(step, mainScript.length - 1)]!;
      step += 1;
      return r;
    },
    neutralizeUntrusted: (content, ctx) => coreNeutralize(content, ctx),
  };
  const tier: TrustTier = "verified";
  const ctx: RoleContext = {
    task: { taskId: "t", targetRepo: dir, goal: "write some files" }, role: "builder",
    identity, autonomy: autonomyForTier(tier), workspace, priorResults: [], engine,
  };

  // modelOverride → a llama-family id whose capability profile is an 8192 window (70% ≈ 5734 tokens).
  const result = await createBuilder({ governedExec: greenExec(), parentCtx: PARENT_CTX, modelOverride: "llama-test" })(ctx);
  const detail = result.detail as { compressions?: number };
  assert.ok((detail.compressions ?? 0) >= 1, `context was compacted at least once (got ${detail.compressions})`);
});
