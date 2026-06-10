/**
 * P1 FIX 5: USER MEMORY — operator standing instructions that persist across sessions
 * (~/.ikbi/instructions.md, overridable via IKBI_INSTRUCTIONS_FILE) and are injected
 * into every new session.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import "../egress/index.js";

import type { ModelResponse } from "../../core/provider/contract.js";
import { ChatSession } from "./session.js";
import { addInstruction, clearInstructions, instructionsPath, loadUserInstructions, readInstructions } from "./user-memory.js";

function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const stop = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

const wt = (): string => mkdtempSync(join(tmpdir(), "ikbi-um-wt-"));

let prev: string | undefined;
let file: string;

beforeEach(() => {
  prev = process.env.IKBI_INSTRUCTIONS_FILE;
  file = join(mkdtempSync(join(tmpdir(), "ikbi-instr-")), "instructions.md");
  process.env.IKBI_INSTRUCTIONS_FILE = file;
});
afterEach(() => {
  if (prev === undefined) delete process.env.IKBI_INSTRUCTIONS_FILE;
  else process.env.IKBI_INSTRUCTIONS_FILE = prev;
});

test("FIX5: instructionsPath honors IKBI_INSTRUCTIONS_FILE", () => {
  assert.equal(instructionsPath(), file);
});

test("FIX5: addInstruction persists to disk and accumulates", () => {
  assert.equal(loadUserInstructions(), undefined, "no instructions to start");
  addInstruction("Always use conventional commits.");
  addInstruction("Never modify package-lock.json.");
  const body = readFileSync(file, "utf8");
  assert.match(body, /Always use conventional commits\./);
  assert.match(body, /Never modify package-lock\.json\./);
  const loaded = loadUserInstructions();
  assert.ok(loaded !== undefined, "instructions load back");
  assert.match(loaded!.content, /conventional commits/);
});

test("FIX5: clearInstructions empties the file", () => {
  addInstruction("Something.");
  assert.ok(readInstructions().length > 0);
  clearInstructions();
  assert.equal(readInstructions().trim().length, 0, "file emptied");
  assert.equal(loadUserInstructions(), undefined, "no instructions after clear");
});

test("FIX5: a new session injects the standing instructions as an isolated data message", async () => {
  addInstruction("Always use conventional commits.");
  const requests: Array<{ messages: Array<{ role: string; content: string; untrusted?: boolean }> }> = [];
  const invoke = (async (req: unknown) => {
    requests.push(req as { messages: Array<{ role: string; content: string; untrusted?: boolean }> });
    return stop("ok");
  }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  const s = new ChatSession("um-1", { invoke, worktree: wt() });
  await s.send("hi");
  const sent = requests[0]!.messages;
  // The clean system prompt stays at index 0; the instructions ride as an isolated UNTRUSTED message.
  assert.equal(sent[0]!.role, "system", "system prompt is first");
  const carrier = sent.find((m) => m.untrusted === true && /conventional commits/.test(m.content));
  assert.ok(carrier, "standing instructions injected as an isolated untrusted carrier");
  assert.ok(carrier!.role !== "system", "never merged into the trusted system slot");
});

test("FIX5: a session started with NO instructions injects no user-memory carrier", async () => {
  writeFileSync(file, "", "utf8");
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const invoke = (async (req: unknown) => {
    requests.push(req as { messages: Array<{ role: string; content: string }> });
    return stop("ok");
  }) as unknown as ConstructorParameters<typeof ChatSession>[1] extends { invoke?: infer F } ? F : never;
  const s = new ChatSession("um-2", { invoke, worktree: wt() });
  await s.send("hi");
  assert.ok(!requests[0]!.messages.some((m) => /standing instructions/i.test(m.content)), "no user-memory message when none set");
});
