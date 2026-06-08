import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

// EGRESS FIRST — the provider registry resolves the fetch guard at import, so egress
// (which registers it) must load before anything on the provider path, exactly as the
// production module barrel (src/modules/index.ts) orders it.
import "../egress/index.js";

import type { ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { routes } from "../../server/registry.js";
import { ChatSession, sessionStore } from "./session.js";
// Importing the module registers the POST /chat route (side effect).
import "./index.js";

afterEach(() => sessionStore.reset());

// --- scripted model responses ----------------------------------------------
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

/** A scripted invoker that returns the next response and records the requests it saw. */
function scripted(responses: ModelResponse[]) {
  const requests: unknown[] = [];
  let i = 0;
  const invoke = (async (req: unknown) => {
    requests.push(req);
    const r = responses[Math.min(i, responses.length - 1)] ?? stop("");
    i += 1;
    return r;
  }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  return { invoke, requests };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-chat-test-"));

// ── route registration + validation ────────────────────────────────────────

test("the POST /chat route is registered via the registerRoutes seam", () => {
  assert.ok(routes.modules().includes("chat"), "chat module registered its routes");
});

test("POST /chat rejects a body without a message (schema validation, no model call)", async () => {
  const { buildServer } = await import("../../server/index.js");
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "POST", url: "/chat", payload: { session_id: "x" } });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /chat enforces the images cap (maxItems, schema validation, no model call)", async () => {
  const { buildServer } = await import("../../server/index.js");
  const app = buildServer();
  await app.ready();
  try {
    const tooMany = Array.from({ length: 9 }, (_v, i) => `data:image/png;base64,A${i}`);
    const res = await app.inject({ method: "POST", url: "/chat", payload: { message: "hi", images: tooMany } });
    assert.equal(res.statusCode, 400, "more than 8 images is rejected before the handler");
  } finally {
    await app.close();
  }
});

// ── session store ───────────────────────────────────────────────────────────

test("sessionStore mints a new id when none is given and reuses an existing one", () => {
  const a = sessionStore.getOrCreate();
  assert.ok(a.id.length > 0);
  const again = sessionStore.getOrCreate(a.id);
  assert.equal(again, a, "same id returns the same session object");
  const b = sessionStore.getOrCreate();
  assert.notEqual(b.id, a.id, "a fresh create mints a distinct id");
});

// ── the tool-calling loop ────────────────────────────────────────────────────

test("send: a plain answer (no tools) returns the model content", async () => {
  const { invoke } = scripted([stop("Foundation is solid. The build is green.")]);
  const s = new ChatSession("s-plain", { invoke, worktree: tmp() });
  const { response, tools } = await s.send("status?");
  assert.equal(response, "Foundation is solid. The build is green.");
  assert.equal(tools.length, 0);
});

test("send: drives the builder tools — write_file then patch — and reports activity", async () => {
  const dir = tmp();
  const { invoke } = scripted([
    toolResp([call("write_file", { path: "g.ts", content: "export const helo = 1;\n" })]),
    toolResp([call("patch", { path: "g.ts", old_string: "helo", new_string: "hello" })]),
    stop("Done — g.ts now exports hello, plumb and square."),
  ]);
  const s = new ChatSession("s-tools", { invoke, worktree: dir });
  const { response, tools } = await s.send("rename helo to hello in g.ts");
  assert.match(response, /hello/);
  assert.deepEqual(tools.map((t) => t.name), ["write_file", "patch"]);
  assert.ok(tools.every((t) => t.ok));
  assert.equal(readFileSync(join(dir, "g.ts"), "utf8"), "export const hello = 1;\n");
});

test("send: a tool path escaping the worktree is rejected (confinement) and surfaced as not-ok", async () => {
  const dir = tmp();
  const { invoke } = scripted([
    toolResp([call("read_file", { path: "../../etc/passwd" })]),
    stop("That path escapes the worktree; I won't read it."),
  ]);
  const s = new ChatSession("s-escape", { invoke, worktree: dir });
  const { tools } = await s.send("read /etc/passwd");
  assert.equal(tools[0]?.name, "read_file");
  assert.equal(tools[0]?.ok, false);
});

test("send: search_files output is fed back so the model can answer from it", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.ts"), "const target = 42;\n");
  const { invoke, requests } = scripted([
    toolResp([call("search_files", { pattern: "target" })]),
    stop("Found it in a.ts."),
  ]);
  const s = new ChatSession("s-search", { invoke, worktree: dir });
  const { response, tools } = await s.send("where is target?");
  assert.equal(tools[0]?.name, "search_files");
  assert.equal(tools[0]?.ok, true);
  assert.match(response, /a\.ts/);
  // The SECOND model call must have received the (neutralized) tool result as a tool-role message.
  const secondReq = requests[1] as { messages: Array<{ role: string; untrusted?: boolean }> };
  assert.ok(secondReq.messages.some((m) => m.role === "tool" && m.untrusted === true), "tool result re-entered as untrusted");
});

test("send: the loop is bounded — a model that always calls tools cannot spin forever", async () => {
  const dir = tmp();
  // Always asks for list_dir → never terminates on its own; the iteration cap must stop it.
  const { invoke } = scripted([toolResp([call("list_dir", { path: "." })])]);
  const s = new ChatSession("s-bounded", { invoke, worktree: dir });
  const { response } = await s.send("loop forever");
  assert.match(response, /iteration limit/);
});

// ── the FULL builder tool suite is wired into chat ───────────────────────────

test("chat advertises the full builder tool suite to the model", async () => {
  const { invoke, requests } = scripted([stop("ready")]);
  const s = new ChatSession("s-toolset", { invoke, worktree: tmp() });
  await s.send("hello");
  const firstReq = requests[0] as { tools: Array<{ name: string }> };
  const names = firstReq.tools.map((t) => t.name);
  // The expanded suite — same tools the builder has — must all be offered to the chat model.
  for (const t of [
    "read_file", "write_file", "list_dir", "search_files", "patch", "terminal",
    "git_status", "git_diff", "git_log", "web_search", "web_extract", "delegate_task",
    "vision_analyze",
  ]) {
    assert.ok(names.includes(t), `chat advertises ${t}`);
  }
});

test("send: operator-pasted images attach to the user turn as multimodal parts", async () => {
  const { invoke, requests } = scripted([stop("I see a red pixel.")]);
  const s = new ChatSession("s-vision", { invoke, worktree: tmp() });
  const dataUrl = "data:image/png;base64,AAAA";
  const { response } = await s.send("what is in this image?", [dataUrl, "https://example.com/x.png", "not-an-image"]);
  assert.match(response, /red pixel/);
  const sent = (requests[0] as { messages: Array<{ role: string; content: string; parts?: Array<{ type: string; image_url?: { url: string } }> }> }).messages;
  const userMsg = sent.find((m) => m.role === "user" && m.parts !== undefined);
  assert.ok(userMsg, "the user turn carries multimodal parts");
  assert.equal(userMsg!.content, "what is in this image?", "content keeps the text fallback");
  // text part + the two VALID image urls (the bogus 'not-an-image' is dropped).
  assert.equal(userMsg!.parts!.length, 3);
  assert.deepEqual(userMsg!.parts!.map((p) => p.type), ["text", "image_url", "image_url"]);
  assert.equal(userMsg!.parts![1]?.image_url?.url, dataUrl);
});

test("send: a text-only turn carries NO parts (unchanged behavior)", async () => {
  const { invoke, requests } = scripted([stop("ok")]);
  const s = new ChatSession("s-novision", { invoke, worktree: tmp() });
  await s.send("just text");
  const sent = (requests[0] as { messages: Array<{ role: string; parts?: unknown }> }).messages;
  const userMsg = sent.find((m) => m.role === "user");
  assert.equal(userMsg?.parts, undefined, "no parts on a text-only turn");
});

test("send: delegate_task runs a focused sub-agent and feeds its result back (chokepoint)", async () => {
  const dir = tmp();
  const { invoke, requests } = scripted([
    toolResp([call("delegate_task", { task: "tidy the build" })]), // [0] chat asks to delegate
    stop("Subtask complete: nothing to change."),                  // [1] the SUB-AGENT's own loop ends
    stop("Delegated and verified — the foundation holds."),        // [2] chat answers from the result
  ]);
  const s = new ChatSession("s-delegate", { invoke, worktree: dir });
  const { response, tools } = await s.send("delegate the tidy-up");
  assert.equal(tools[0]?.name, "delegate_task");
  assert.equal(tools[0]?.ok, true);
  assert.match(response, /foundation holds/);
  // The sub-agent's RESULT must re-enter the chat as an UNTRUSTED tool-role message (the chokepoint).
  const afterDelegate = requests[2] as { messages: Array<{ role: string; untrusted?: boolean }> };
  assert.ok(
    afterDelegate.messages.some((m) => m.role === "tool" && m.untrusted === true),
    "delegate_task result re-entered as untrusted",
  );
});
