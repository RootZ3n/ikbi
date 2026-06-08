import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

// EGRESS FIRST — the provider registry resolves the fetch guard at import.
import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { ChatSession, sessionStore } from "./session.js";
import { SessionMemory } from "./memory.js";
import "./index.js";

afterEach(() => sessionStore.reset());

// ── SessionMemory unit ───────────────────────────────────────────────────────

test("memory: records modified files, command/test results, and decisions", () => {
  const m = new SessionMemory();
  assert.equal(m.isEmpty(), true);
  m.recordToolActivity([
    { name: "write_file", ok: true, summary: "a.ts" },
    { name: "patch", ok: true, summary: "b.ts" },
    { name: "terminal", ok: false, summary: "pnpm test" },
    { name: "read_file", ok: true, summary: "c.ts" }, // reads are NOT modifications
  ]);
  m.recordDecision("Renamed helo to hello; tests still red.");
  const snap = m.snapshot();
  assert.deepEqual(snap.filesModified, ["a.ts", "b.ts"]);
  assert.deepEqual(snap.testResults, [{ command: "pnpm test", ok: false }]);
  assert.equal(snap.decisions.length, 1);
  assert.equal(m.isEmpty(), false);
});

test("memory: a failed write is NOT recorded as a modification", () => {
  const m = new SessionMemory();
  m.recordToolActivity([{ name: "write_file", ok: false, summary: "x.ts" }]);
  assert.deepEqual(m.snapshot().filesModified, []);
});

test("memory: modified files dedupe", () => {
  const m = new SessionMemory();
  m.recordToolActivity([{ name: "write_file", ok: true, summary: "a.ts" }]);
  m.recordToolActivity([{ name: "patch", ok: true, summary: "a.ts" }]);
  assert.deepEqual(m.snapshot().filesModified, ["a.ts"]);
});

test("memory: summary is non-empty, structured, and bounded under ~500 tokens", () => {
  const m = new SessionMemory();
  for (let i = 0; i < 50; i++) {
    m.recordToolActivity([{ name: "write_file", ok: true, summary: `file-${i}.ts` }, { name: "terminal", ok: i % 2 === 0, summary: `cmd-${i}` }]);
    m.recordDecision(`decision number ${i} ` + "x".repeat(300));
  }
  const s = m.summary();
  assert.match(s, /CONVERSATION MEMORY/);
  assert.match(s, /Files modified/);
  assert.ok(s.length <= 1_900, `summary bounded (${s.length} chars)`);
});

test("memory: empty memory yields an empty summary (nothing to inject)", () => {
  assert.equal(new SessionMemory().summary(), "");
});

// ── session integration ──────────────────────────────────────────────────────

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });
const toolResp = (calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

/** A scripted invoker that records every request it saw. */
function scripted(responses: ModelResponse[]) {
  const requests: Array<{ messages: Array<{ role: string; content: string; untrusted?: boolean }> }> = [];
  let i = 0;
  const invoke = (async (req: { messages: Array<{ role: string; content: string; untrusted?: boolean }> }) => {
    requests.push(req);
    const r = responses[Math.min(i, responses.length - 1)] ?? stop("");
    i += 1;
    return r;
  }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  return { invoke, requests };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-mem-"));

test("session: facts from turn 1 ride turn 2 as ISOLATED UNTRUSTED data (not in the system prompt)", async () => {
  const dir = tmp();
  // Turn 1: write a file, then conclude. Turn 2: a plain answer — we inspect how memory is carried.
  const { invoke, requests } = scripted([
    toolResp([call("write_file", { path: "g.ts", content: "export const x = 1;\n" })]),
    stop("Created g.ts with the export."),
    stop("Yes, g.ts is still there."),
  ]);
  const s = new ChatSession("mem-1", { invoke, worktree: dir });

  await s.send("create g.ts");
  // After turn 1, memory has the file + the decision.
  assert.deepEqual(s.memory.snapshot().filesModified, ["g.ts"]);

  await s.send("is g.ts still there?");
  const lastReq = requests[requests.length - 1]!;
  // The memory summary rides as an UNTRUSTED data-role message — NEVER in the trusted system prompt.
  const sys = lastReq.messages.find((m) => m.role === "system")!;
  assert.doesNotMatch(sys.content, /CONVERSATION MEMORY/, "memory is NOT in the trusted system prompt");
  const memCarrier = lastReq.messages.find((m) => m.untrusted === true && /CONVERSATION MEMORY/.test(m.content));
  assert.ok(memCarrier, "memory summary is carried as an untrusted (neutralized) message");
  assert.equal(memCarrier?.role, "user", "untrusted memory occupies a data role");
  assert.match(memCarrier!.content, /Files modified so far: g\.ts/);
});

test("session: turn 1 carries NO memory at all (nothing recorded yet)", async () => {
  const dir = tmp();
  const { invoke, requests } = scripted([stop("hello")]);
  const s = new ChatSession("mem-2", { invoke, worktree: dir });
  await s.send("hi");
  const msgs = requests[0]!.messages;
  assert.doesNotMatch(msgs.find((m) => m.role === "system")!.content, /CONVERSATION MEMORY/, "first turn has clean system prompt");
  assert.ok(!msgs.some((m) => /CONVERSATION MEMORY/.test(m.content)), "no memory carrier on the first turn");
});

test("session: a terminal result is remembered as a command/test outcome", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "g.ts"), "x\n");
  const { invoke } = scripted([
    toolResp([call("terminal", { command: "ls" })]),
    stop("listed the directory"),
  ]);
  // No parent identity wired in this session → terminal fails closed (ok:false). Still remembered.
  const s = new ChatSession("mem-3", { invoke, worktree: dir });
  await s.send("list files");
  const tests = s.memory.snapshot().testResults;
  assert.equal(tests.length, 1);
  assert.equal(tests[0]?.command, "ls");
});
