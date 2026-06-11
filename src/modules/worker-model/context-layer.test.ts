import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelMessage } from "../../core/provider/contract.js";
import { ContextLayer, DEFAULT_CONTEXT_LAYER_CONFIG } from "./context-layer.js";
import { estimateTokens } from "./context-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a tool result message. */
const toolMsg = (content: string, toolCallId = "tc1"): ModelMessage => ({
  role: "tool",
  content,
  toolCallId,
  untrusted: true,
});

/** Build a system/user/assistant message. */
const sysMsg = (content: string): ModelMessage => ({ role: "system", content });
const userMsg = (content: string): ModelMessage => ({ role: "user", content });
const assistantMsg = (content: string): ModelMessage => ({ role: "assistant", content });

/** Build a realistic read_file result with N lines. */
const readFileResult = (lines: number, pathHint = "src/foo.ts"): string =>
  [`// ${pathHint}`, ...Array.from({ length: lines - 1 }, (_, i) => `line ${i + 2}`)].join("\n");

/** Build a realistic write_file result. */
const writeFileResult = (bytes: number, path: string): string => `wrote ${bytes} bytes to ${path}`;

/** Build a realistic list_dir result. */
const listDirResult = (entries: number): string =>
  Array.from({ length: entries }, (_, i) => (i % 3 === 0 ? `dir${i}/` : `file${i}.ts`)).join("\n");

/** Build a realistic search_files result. */
const searchFilesResult = (matches: number, files: number): string => {
  const lines: string[] = [];
  for (let f = 0; f < files; f++) {
    for (let m = 0; m < Math.ceil(matches / files); m++) {
      lines.push(`src/file${f}.ts:${10 + m}: matched line content here`);
    }
  }
  return lines.join("\n");
};

/** Build a realistic terminal result. */
const terminalResult = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `output line ${i + 1}`).join("\n");

/**
 * Build a standard header (system + goal + success + prior) — the uncompressible
 * header that the builder always preserves.
 */
function header(): ModelMessage[] {
  return [
    sysMsg("You are the BUILDER..."),
    userMsg("Goal: implement feature X"),
    userMsg("Success condition: feature X works"),
    userMsg("Prior results: scout found 3 issues"),
  ];
}

// ── Default config ─────────────────────────────────────────────────────────

test("DEFAULT_CONTEXT_LAYER_CONFIG has expected values", () => {
  assert.equal(DEFAULT_CONTEXT_LAYER_CONFIG.tokenBudget, 40_000);
  assert.equal(DEFAULT_CONTEXT_LAYER_CONFIG.recencyWindow, 5);
  assert.equal(DEFAULT_CONTEXT_LAYER_CONFIG.headerLen, 4);
});

// ── ContextLayer construction ──────────────────────────────────────────────

test("ContextLayer uses defaults when no config is passed", () => {
  const layer = new ContextLayer();
  const cfg = layer.getConfig();
  assert.equal(cfg.tokenBudget, 40_000);
  assert.equal(cfg.recencyWindow, 5);
  assert.equal(cfg.headerLen, 4);
});

test("ContextLayer accepts partial config overrides", () => {
  const layer = new ContextLayer({ tokenBudget: 20_000 });
  const cfg = layer.getConfig();
  assert.equal(cfg.tokenBudget, 20_000);
  assert.equal(cfg.recencyWindow, 5); // default
});

test("ContextLayer starts with zero compressions and empty index", () => {
  const layer = new ContextLayer();
  assert.equal(layer.getCompressions(), 0);
  assert.equal(layer.getTotalMessagesCompressed(), 0);
  assert.equal(layer.getContextIndex().size, 0);
});

// ── No-op when under budget ────────────────────────────────────────────────

test("compress is a no-op when under the token budget", () => {
  const layer = new ContextLayer({ tokenBudget: 100_000 });
  const messages = [...header(), toolMsg(readFileResult(50))];
  const before = messages.length;
  const result = layer.compress(messages);
  assert.equal(result.compressed, false);
  assert.equal(messages.length, before, "messages untouched");
});

// ── Compression of old tool results ────────────────────────────────────────

test("compress reduces token count by compressing old tool results", () => {
  // Use a very low budget to force compression
  const layer = new ContextLayer({ tokenBudget: 500, recencyWindow: 2, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    // Old tool results (will be compressed)
    toolMsg(readFileResult(100, "src/old1.ts"), "tc1"),
    toolMsg(readFileResult(100, "src/old2.ts"), "tc2"),
    toolMsg(readFileResult(100, "src/old3.ts"), "tc3"),
    toolMsg(readFileResult(100, "src/old4.ts"), "tc4"),
    // Recent tool results (will be kept)
    toolMsg(readFileResult(100, "src/recent1.ts"), "tc5"),
    toolMsg(readFileResult(100, "src/recent2.ts"), "tc6"),
  ];
  const result = layer.compress(messages);
  assert.equal(result.compressed, true);
  assert.ok(result.before !== undefined);
  assert.ok(result.after !== undefined);
  assert.ok(result.after! < result.before!, "token count decreased");
  assert.ok(result.messagesCompressed! > 0);
});

// ── Recency window preservation ────────────────────────────────────────────

test("compress preserves the last N tool results (recency window)", () => {
  const layer = new ContextLayer({ tokenBudget: 500, recencyWindow: 3, headerLen: 4 });
  const recentContents = ["recent-A", "recent-B", "recent-C"];
  const messages: ModelMessage[] = [
    ...header(),
    // Old tool results
    toolMsg(readFileResult(100, "src/old1.ts"), "tc1"),
    toolMsg(readFileResult(100, "src/old2.ts"), "tc2"),
    toolMsg(readFileResult(100, "src/old3.ts"), "tc3"),
    // Recent tool results (should be preserved)
    toolMsg(recentContents[0]!, "tc4"),
    toolMsg(recentContents[1]!, "tc5"),
    toolMsg(recentContents[2]!, "tc6"),
  ];

  layer.compress(messages);

  // The last 3 tool results should be unchanged
  const toolMessages = messages.filter((m) => m.role === "tool");
  const lastThree = toolMessages.slice(-3);
  assert.deepEqual(
    lastThree.map((m) => m.content),
    recentContents,
    "recent tool results preserved verbatim",
  );
});

test("compress with recencyWindow=1 keeps only the very last tool result", () => {
  const layer = new ContextLayer({ tokenBudget: 500, recencyWindow: 1, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(readFileResult(100, "src/old1.ts"), "tc1"),
    toolMsg(readFileResult(100, "src/old2.ts"), "tc2"),
    toolMsg(readFileResult(100, "src/old3.ts"), "tc3"),
    toolMsg("THE-RECENT-ONE", "tc4"),
  ];

  layer.compress(messages);

  const toolMsgs = messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs[toolMsgs.length - 1]!.content, "THE-RECENT-ONE");
});

// ── Header preservation ────────────────────────────────────────────────────

test("compress NEVER compresses the header (system + goal + success + prior)", () => {
  const layer = new ContextLayer({ tokenBudget: 200, recencyWindow: 0, headerLen: 4 });
  const hdr = header();
  const messages: ModelMessage[] = [
    ...hdr,
    toolMsg(readFileResult(100, "src/old1.ts"), "tc1"),
    toolMsg(readFileResult(100, "src/old2.ts"), "tc2"),
  ];

  layer.compress(messages);

  // Header messages should be unchanged
  for (let i = 0; i < 4; i++) {
    assert.equal(messages[i]!.content, hdr[i]!.content, `header[${i}] unchanged`);
    assert.equal(messages[i]!.role, hdr[i]!.role, `header[${i}] role unchanged`);
  }
});

test("compress NEVER compresses assistant messages", () => {
  const layer = new ContextLayer({ tokenBudget: 200, recencyWindow: 0, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    assistantMsg("I will read the file first to understand the codebase."),
    toolMsg(readFileResult(100, "src/old.ts"), "tc1"),
  ];

  const beforeContent = messages[4]!.content;
  layer.compress(messages);
  assert.equal(messages[4]!.content, beforeContent, "assistant message unchanged");
});

// ── Compression patterns ───────────────────────────────────────────────────

test("compress summarizes read_file results as line count + preview", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 0, headerLen: 4 });
  const content = readFileResult(200, "src/big-file.ts");
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(content, "tc1"),
  ];

  layer.compress(messages);
  const compressed = messages[4]!.content;
  assert.match(compressed, /\[COMPRESSED\]/);
  assert.match(compressed, /200 lines/);
});

test("compress preserves write_file results (already short)", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 0, headerLen: 4 });
  const content = writeFileResult(1234, "src/output.ts");
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(content, "tc1"),
  ];

  layer.compress(messages);
  // write_file results are already short — should be kept as-is or unchanged
  assert.ok(messages[4]!.content.includes("1234 bytes"));
  assert.ok(messages[4]!.content.includes("src/output.ts"));
});

test("compress summarizes list_dir results as entry count", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 0, headerLen: 4 });
  const content = listDirResult(50);
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(content, "tc1"),
  ];

  layer.compress(messages);
  const compressed = messages[4]!.content;
  assert.match(compressed, /\[COMPRESSED\]/);
  assert.match(compressed, /50 entries/);
});

test("compress summarizes search_files results as match count", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 0, headerLen: 4 });
  const content = searchFilesResult(10, 3);
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(content, "tc1"),
  ];

  layer.compress(messages);
  const compressed = messages[4]!.content;
  assert.match(compressed, /\[COMPRESSED\]/);
  assert.match(compressed, /match/);
});

test("compress summarizes terminal results as line count + preview", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 0, headerLen: 4 });
  const content = terminalResult(20);
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(content, "tc1"),
  ];

  layer.compress(messages);
  const compressed = messages[4]!.content;
  assert.match(compressed, /\[COMPRESSED\]/);
  assert.match(compressed, /20 lines/);
});

// ── File index (context_index) ─────────────────────────────────────────────

test("scanForIndex populates the file index from tool results", () => {
  const layer = new ContextLayer();
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(readFileResult(50, "src/app.ts"), "tc1"),
    toolMsg(writeFileResult(1024, "src/out.ts"), "tc2"),
    toolMsg(listDirResult(10), "tc3"),
  ];

  layer.scanForIndex(messages);
  const index = layer.getContextIndex();

  // write_file has a clear path pattern
  assert.ok(index.has("src/out.ts"), "write_file path recorded");
  const entry = index.get("src/out.ts")!;
  assert.equal(entry.path, "src/out.ts");
  assert.ok(entry.keyFacts.some((f) => f.includes("bytes written")));
});

test("scanForIndex updates existing entries on re-read", () => {
  const layer = new ContextLayer();
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(writeFileResult(100, "src/app.ts"), "tc1"),
    toolMsg(writeFileResult(200, "src/app.ts"), "tc2"),
  ];

  layer.scanForIndex(messages);
  const index = layer.getContextIndex();
  const entry = index.get("src/app.ts")!;
  assert.equal(entry.messageIndex, 5, "updated to latest index");
  assert.ok(entry.keyFacts.some((f) => f.includes("200 bytes")));
});

test("compression populates the file index for compressed messages", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 0, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(writeFileResult(5000, "src/big.ts"), "tc1"),
    toolMsg(writeFileResult(3000, "src/other.ts"), "tc2"),
  ];

  layer.compress(messages);
  const index = layer.getContextIndex();
  assert.ok(index.has("src/big.ts"), "big.ts in index after compression");
  assert.ok(index.has("src/other.ts"), "other.ts in index after compression");
});

// ── Compression counters ───────────────────────────────────────────────────

test("getCompressions increments on each compression pass", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 0, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(readFileResult(100, "src/a.ts"), "tc1"),
    toolMsg(readFileResult(100, "src/b.ts"), "tc2"),
  ];

  layer.compress(messages);
  assert.equal(layer.getCompressions(), 1);
  assert.ok(layer.getTotalMessagesCompressed() > 0);
});

test("getCompressions does not increment when no compression needed", () => {
  const layer = new ContextLayer({ tokenBudget: 100_000 });
  const messages: ModelMessage[] = [...header(), toolMsg("tiny")];

  layer.compress(messages);
  assert.equal(layer.getCompressions(), 0);
});

// ── Edge cases ─────────────────────────────────────────────────────────────

test("compress handles empty messages array", () => {
  const layer = new ContextLayer({ tokenBudget: 0 }); // budget 0 forces attempt
  const messages: ModelMessage[] = [];
  const result = layer.compress(messages);
  assert.equal(result.compressed, false);
  assert.equal(messages.length, 0);
});

test("compress handles single system message", () => {
  const layer = new ContextLayer({ tokenBudget: 0 });
  const messages: ModelMessage[] = [sysMsg("hello")];
  const result = layer.compress(messages);
  assert.equal(result.compressed, false);
});

test("compress handles messages with only header (no tool results)", () => {
  const layer = new ContextLayer({ tokenBudget: 0 });
  const messages: ModelMessage[] = header();
  const result = layer.compress(messages);
  assert.equal(result.compressed, false);
});

test("compress handles messages where all are in the header", () => {
  const layer = new ContextLayer({ tokenBudget: 0, headerLen: 10 });
  const messages: ModelMessage[] = [...header(), toolMsg("a"), toolMsg("b")];
  const result = layer.compress(messages);
  // All messages are within headerLen, so nothing is compressible
  assert.equal(result.compressed, false);
});

test("compress handles messages where all tool results are in recency window", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 10, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(readFileResult(100), "tc1"),
    toolMsg(readFileResult(100), "tc2"),
  ];
  const result = layer.compress(messages);
  // Both tool results are within recencyWindow=10, so nothing compressible
  assert.equal(result.compressed, false);
});

test("compress handles already-compressed messages (skips them)", () => {
  const layer = new ContextLayer({ tokenBudget: 200, recencyWindow: 0, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg("[COMPRESSED] File content (100 lines): preview...", "tc1"),
    toolMsg("[COMPRESSED] File content (200 lines): preview...", "tc2"),
  ];
  const result = layer.compress(messages);
  // Already compressed — cannot compress further
  assert.equal(result.compressed, false);
});

test("compress preserves messages with actionable feedback markers", () => {
  const layer = new ContextLayer({ tokenBudget: 200, recencyWindow: 0, headerLen: 4 });
  const checkContent = "IKBI-CHECK-RESULTS these are the check results IKBI-CHECK-RESULTS";
  const harnessContent = "IKBI-HARNESS-FEEDBACK do this next IKBI-HARNESS-FEEDBACK";
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(checkContent, "tc1"),
    toolMsg(harnessContent, "tc2"),
  ];

  layer.compress(messages);
  // These should NOT be compressed (they are ikbi-authored, trusted)
  assert.equal(messages[4]!.content, checkContent);
  assert.equal(messages[5]!.content, harnessContent);
});

test("compress never throws (error resilience)", () => {
  const layer = new ContextLayer({ tokenBudget: 500, recencyWindow: 0, headerLen: 4 });
  // Pass messages with weird content that might cause issues
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg("", "tc1"), // empty content
    toolMsg("\n\n\n", "tc2"), // only newlines
    toolMsg("x".repeat(100_000), "tc3"), // huge content
  ];

  // Should not throw
  const result = layer.compress(messages);
  assert.equal(typeof result.compressed, "boolean");
});

// ── Compression reduces tokens below budget ────────────────────────────────

test("compression brings token count at or below budget when possible", () => {
  // Create a scenario with many large old tool results
  const layer = new ContextLayer({ tokenBudget: 1000, recencyWindow: 2, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    ...Array.from({ length: 20 }, (_, i) =>
      toolMsg(readFileResult(50, `src/file${i}.ts`), `tc${i}`),
    ),
    // Last 2 are recent
    toolMsg(readFileResult(50, "src/recent1.ts"), "tc20"),
    toolMsg(readFileResult(50, "src/recent2.ts"), "tc21"),
  ];

  const before = estimateTokens(messages);
  assert.ok(before > 1000, "starts over budget");

  const result = layer.compress(messages);
  assert.equal(result.compressed, true);
  assert.ok(result.after! <= 1000 * 1.1, `after (${result.after}) should be near budget (1000)`);
});

// ── Multiple compression passes ────────────────────────────────────────────

test("multiple compression passes accumulate counters correctly", () => {
  const layer = new ContextLayer({ tokenBudget: 100, recencyWindow: 0, headerLen: 4 });

  // First pass
  const messages1: ModelMessage[] = [
    ...header(),
    toolMsg(readFileResult(100, "src/a.ts"), "tc1"),
    toolMsg(readFileResult(100, "src/b.ts"), "tc2"),
  ];
  layer.compress(messages1);
  const compressions1 = layer.getCompressions();
  const total1 = layer.getTotalMessagesCompressed();

  // Second pass (new messages array)
  const messages2: ModelMessage[] = [
    ...header(),
    toolMsg(readFileResult(100, "src/c.ts"), "tc3"),
    toolMsg(readFileResult(100, "src/d.ts"), "tc4"),
  ];
  layer.compress(messages2);

  assert.ok(layer.getCompressions() >= compressions1 + 1);
  assert.ok(layer.getTotalMessagesCompressed() >= total1 + 1);
});

// ── Mixed message types ────────────────────────────────────────────────────

test("compress handles a realistic mix of message types", () => {
  const layer = new ContextLayer({ tokenBudget: 800, recencyWindow: 2, headerLen: 4 });
  const messages: ModelMessage[] = [
    ...header(),
    // Old exploration
    assistantMsg("Let me read the file to understand the structure."),
    toolMsg(readFileResult(80, "src/index.ts"), "tc1"),
    assistantMsg("Now let me check the directory."),
    toolMsg(listDirResult(20), "tc2"),
    assistantMsg("I'll search for the function."),
    toolMsg(searchFilesResult(5, 2), "tc3"),
    assistantMsg("Let me write the fix."),
    toolMsg(writeFileResult(500, "src/fix.ts"), "tc4"),
    // Recent (kept)
    assistantMsg("Now I'll verify the change."),
    toolMsg(readFileResult(80, "src/fix.ts"), "tc5"),
    toolMsg(terminalResult(10), "tc6"),
  ];

  const result = layer.compress(messages);
  // Should compress some old tool results
  if (result.compressed) {
    assert.ok(result.after! < result.before!);
    // Assistant messages should still be there
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    assert.equal(assistantMsgs.length, 5, "all assistant messages preserved");
  }
});

// ── write_file compression ─────────────────────────────────────────────────

test("compress keeps write_file results as-is (already one-liner)", () => {
  const layer = new ContextLayer({ tokenBudget: 500, recencyWindow: 0, headerLen: 4 });
  const writeResult = writeFileResult(42, "src/tiny.ts");
  const messages: ModelMessage[] = [
    ...header(),
    toolMsg(writeResult, "tc1"),
    // Need another message to be over budget
    toolMsg(readFileResult(200, "src/big.ts"), "tc2"),
  ];

  layer.compress(messages);
  // The write_file result should be unchanged (it's already short)
  assert.equal(messages[4]!.content, writeResult);
});

// ── Context index integration ──────────────────────────────────────────────

test("getContextIndex returns a read-only map", () => {
  const layer = new ContextLayer();
  layer.scanForIndex([...header(), toolMsg(writeFileResult(100, "src/a.ts"), "tc1")]);
  const index = layer.getContextIndex();
  // TypeScript prevents mutation via ReadonlyMap, but verify the type
  assert.equal(typeof index.get, "function");
  assert.equal(typeof index.has, "function");
  assert.equal(index.size, 1);
});
