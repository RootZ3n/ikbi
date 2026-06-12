/**
 * ikbi builder HARDENING — the cheap-model anti-footgun rails (Principles 1–6).
 *
 * These tests pin the redesign that makes it near-impossible for a cheap model to fail in the
 * predictable ways: blind whole-file overwrites (1), editing the wrong file (2), unparseable
 * check output (3), declaring done on a stale green (4b), losing the thread over many rounds (5),
 * and schemas without worked examples (6). Pure mock-engine drive — no live model.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity, TrustTier } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ModelRequest, ModelResponse, ToolCall } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import {
  buildContextReminder,
  createBuilder,
  extractCheckLocation,
  extractTargetFiles,
  TOOLS,
  type ToolCallError,
} from "./builder.js";
import type { RoleContext, RoleEngine, RoleResult } from "./contract.js";

// --- governed-exec wiring (mirrors builder.test) ---------------------------
const PARENT_CTX: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
})();
const greenExec = () => ({ run: async (_req: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) });
const redExec = (failPurpose = "test") => ({
  run: async (req: ExecRequest): Promise<ExecResult> => {
    const fails = (req.purpose ?? "").includes(failPurpose);
    return { executed: true, exitCode: fails ? 1 : 0, stdoutTail: fails ? "FAIL: expected 7, got 3" : "ok", stderrTail: "" };
  },
});
const run = (ctx: RoleContext, exec: { run: (req: ExecRequest) => Promise<ExecResult> } = greenExec()) =>
  createBuilder({ governedExec: exec, parentCtx: PARENT_CTX })(ctx);

// --- model-response builders (mirrors builder.test) ------------------------
function base(): Omit<ModelResponse, "content" | "finishReason" | "toolCalls"> {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const lengthResp = (): ModelResponse => ({ ...base(), content: "", finishReason: "length" });
const toolResp = (calls: ToolCall[]): ModelResponse => ({ ...base(), content: "", finishReason: "tool_calls", toolCalls: calls });
const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const runChecksResp = (id = "rc1"): ModelResponse => toolResp([call("run_checks", {}, id)]);
const doneResp = (filesReadBack: string[], satisfied = true, id = "done1"): ModelResponse =>
  toolResp([call("done", { successCondition: "the goal is met", filesReadBack, selfCheck: "re-read the changed files; they satisfy the goal", satisfied }, id)]);

function mockEngine(responses: ModelResponse[]) {
  const requests: ModelRequest[] = [];
  let i = 0;
  const engine: RoleEngine = {
    invokeModel: async (req) => { requests.push(req); const r = responses[Math.min(i, responses.length - 1)] ?? lengthResp(); i += 1; return r; },
    neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
  };
  return { engine, requests };
}

function makeCtx(dir: string, tier: TrustTier, engine: RoleEngine, goal = "build the thing", priorResults: RoleResult[] = []): RoleContext {
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: tier, spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = { id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: dir, identity, state: "allocated", createdAt: 0 };
  return { task: { taskId: "t-1", targetRepo: dir, goal }, role: "builder", identity, autonomy: autonomyForTier(tier), workspace, priorResults, engine };
}
const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-builder-hard-"));

// ── PRINCIPLE 1: READ-BEFORE-WRITE ──────────────────────────────────────────

test("P1: write_file on an EXISTING file that was never read is REJECTED (no blind clobber)", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "routes.ts"), "export const original = 1;\n");
  const { engine } = mockEngine([
    toolResp([call("write_file", { path: "routes.ts", content: "export const clobbered = 2;\n" })]),
    lengthResp(),
  ]);
  const result = await run(makeCtx(dir, "verified", engine));
  const detail = result.detail as { rejectedToolCalls: ToolCallError[]; filesWritten: string[] };
  const rej = detail.rejectedToolCalls.find((r) => r.tool === "write_file");
  assert.ok(rej, "the blind overwrite was rejected");
  assert.match(rej?.error ?? "", /write before read/i);
  assert.equal(detail.filesWritten.length, 0, "the existing file was not clobbered");
});

test("P1: creating a NEW file (nothing to clobber) needs no prior read — allowed", async () => {
  const dir = tmp();
  const { engine } = mockEngine([toolResp([call("write_file", { path: "fresh.ts", content: "export const x = 1;\n" })]), runChecksResp(), doneResp(["fresh.ts"])]);
  const result = await run(makeCtx(dir, "verified", engine));
  assert.equal(result.outcome, "success");
  assert.deepEqual((result.detail as { filesWritten: string[] }).filesWritten, ["fresh.ts"]);
});

test("P1: READ → WRITE converges — once the existing file is read, the overwrite is allowed", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "routes.ts"), "export const original = 1;\n");
  const { engine } = mockEngine([
    toolResp([call("read_file", { path: "routes.ts" })]),
    toolResp([call("write_file", { path: "routes.ts", content: "export const fixed = 1;\n" })]),
    runChecksResp(),
    doneResp(["routes.ts"]),
  ]);
  const result = await run(makeCtx(dir, "verified", engine));
  assert.equal(result.outcome, "success", "read-then-write is the supported path");
  assert.deepEqual((result.detail as { filesWritten: string[] }).filesWritten, ["routes.ts"]);
});

test("P1: patch is EXEMPT — it requires an exact unique anchor, so an unread existing file is fine", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "g.ts"), "export const helo = 1;\n");
  const { engine } = mockEngine([
    toolResp([call("patch", { path: "g.ts", old_string: "helo", new_string: "hello" })]),
    runChecksResp(),
    doneResp(["g.ts"]),
  ]);
  const result = await run(makeCtx(dir, "verified", engine));
  assert.equal(result.outcome, "success", "patch is not gated by read-before-write (anchor already implies knowledge)");
  const rej = (result.detail as { rejectedToolCalls: ToolCallError[] }).rejectedToolCalls.find((r) => r.tool === "patch");
  assert.equal(rej, undefined, "patch on the unread file was NOT rejected");
});

// ── PRINCIPLE 2: FILE TARGETING FROM THE GOAL ───────────────────────────────

test("P2: extractTargetFiles lifts path-like tokens with code extensions, ignores prose/versions", () => {
  assert.deepEqual(extractTargetFiles("Fix src/routes.ts: add a <link> at line 393"), ["src/routes.ts"]);
  assert.deepEqual(extractTargetFiles("build the thing"), [], "no path → no targets");
  assert.deepEqual(extractTargetFiles("upgrade deepseek-v4 to v2.5 and bump 1.0.0"), [], "versions are not files");
  assert.ok(extractTargetFiles("edit ui/index.html and src/app.tsx").includes("src/app.tsx"));
  assert.ok(!extractTargetFiles("touch ../../etc/passwd.txt").length, "traversal tokens are dropped");
});

test("P2: the goal's named files appear as PRIMARY TARGETS in the (trusted) system prompt", async () => {
  const dir = tmp();
  const { engine, requests } = mockEngine([lengthResp()]);
  await run(makeCtx(dir, "verified", engine, "Fix src/routes.ts: add the stylesheet link"));
  const sys = String((requests[0]?.messages ?? []).find((m) => m.role === "system")?.content);
  assert.match(sys, /PRIMARY TARGETS/);
  assert.match(sys, /src\/routes\.ts/);
  assert.match(sys, /Work ONLY on the file\(s\) above/i);
});

test("P2: a goal naming no file adds NO primary-targets section (no spurious restriction)", async () => {
  const dir = tmp();
  const { engine, requests } = mockEngine([lengthResp()]);
  await run(makeCtx(dir, "verified", engine, "build the thing"));
  const sys = String((requests[0]?.messages ?? []).find((m) => m.role === "system")?.content);
  assert.doesNotMatch(sys, /PRIMARY TARGETS/);
});

// ── PRINCIPLE 3: STRUCTURED run_checks FEEDBACK ─────────────────────────────

test("P3: run_checks feedback is STRUCTURED — header + per-check status + error field", async () => {
  const dir = tmp();
  const { engine, requests } = mockEngine([runChecksResp(), doneResp(["x"]), lengthResp()]);
  await run(makeCtx(dir, "verified", engine), redExec("test"));
  const rc = String(requests.flatMap((r) => r.messages ?? []).find((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("IKBI-CHECK-RESULTS-BEGIN"))?.content);
  assert.match(rc, /CHECK RESULTS: FAILED \(\d+ of \d+ check\(s\) failing\)/, "a structured header naming the failure count");
  assert.match(rc, /\[check: test\] FAILED/, "the failing check is labelled by name");
  assert.match(rc, /\[check: typecheck\] PASS/, "the passing check is labelled PASS");
  assert.match(rc, /\n {2}error: /, "each failure carries a parsed error: field");
  assert.match(rc, /expected 7, got 3/, "the raw output tail is still included for context");
});

test("P3: extractCheckLocation pulls a file:line from tsc and jest/node output shapes", () => {
  assert.equal(extractCheckLocation("src/routes.ts(393,5): error TS1005: ';' expected."), "src/routes.ts:393");
  assert.equal(extractCheckLocation("  at Object.<anonymous> (src/app.test.ts:42:9)"), "src/app.test.ts:42");
  assert.equal(extractCheckLocation("all good, no failures"), undefined);
});

// ── PRINCIPLE 4(b): DONE IS GATED ON A FRESH (NON-STALE) run_checks ─────────

test("P4b: a write AFTER the last run_checks makes the green STALE — done is rejected until re-run", async () => {
  const dir = tmp();
  const { engine } = mockEngine([
    toolResp([call("write_file", { path: "a.ts", content: "export const a = 1;\n" })]),
    runChecksResp("rc1"), // green
    toolResp([call("write_file", { path: "b.ts", content: "export const b = 2;\n" })]), // edit AFTER the green → stale
    doneResp(["a.ts", "b.ts"]), // rejected: checks are stale
    runChecksResp("rc2"), // re-run → fresh green
    doneResp(["a.ts", "b.ts"]), // now accepted
  ]);
  const result = await run(makeCtx(dir, "verified", engine));
  assert.equal(result.outcome, "success", "the builder recovered by re-running checks after the late edit");
  const detail = result.detail as { rejectedToolCalls: ToolCallError[]; checksRuns: number };
  const stale = detail.rejectedToolCalls.find((r) => r.tool === "done" && /stale/i.test(r.error));
  assert.ok(stale, "the done on a stale green was rejected with a stale reason");
  assert.equal(detail.checksRuns, 2, "it had to run checks a SECOND time after the late edit");
});

test("P4b: no write after run_checks → the green is NOT stale → done is accepted (the normal path)", async () => {
  const dir = tmp();
  const { engine } = mockEngine([toolResp([call("write_file", { path: "a.ts", content: "export const a = 1;\n" })]), runChecksResp(), doneResp(["a.ts"])]);
  const result = await run(makeCtx(dir, "verified", engine));
  assert.equal(result.outcome, "success", "write → run_checks → done (no intervening edit) is unaffected by the staleness gate");
});

// ── PRINCIPLE 5: CONTEXT REMINDER EVERY N ROUNDS ────────────────────────────

test("P5: a CONTEXT REMINDER is injected as a trusted message on the 5th round", async () => {
  const dir = tmp();
  // 5 tool rounds (list_dir) then a length finish — the reminder rides into the 5th request.
  const { engine, requests } = mockEngine([
    toolResp([call("list_dir", { path: "." })]),
    toolResp([call("list_dir", { path: "." })]),
    toolResp([call("list_dir", { path: "." })]),
    toolResp([call("list_dir", { path: "." })]),
    toolResp([call("list_dir", { path: "." })]),
    lengthResp(),
  ]);
  await run(makeCtx(dir, "verified", engine, "Fix src/routes.ts: add the link"));
  const reminder = requests.flatMap((r) => r.messages ?? []).find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("CONTEXT REMINDER"));
  assert.ok(reminder, "the reminder was injected");
  assert.notEqual(reminder?.untrusted, true, "the reminder is trusted ikbi scaffolding the model should act on");
  assert.match(String(reminder?.content), /src\/routes\.ts/, "it restates the primary target");
});

test("P5: NO reminder before the interval (short runs are not spammed)", async () => {
  const dir = tmp();
  const { engine, requests } = mockEngine([runChecksResp(), doneResp(["x"])]);
  await run(makeCtx(dir, "verified", engine));
  const reminder = requests.flatMap((r) => r.messages ?? []).find((m) => typeof m.content === "string" && m.content.includes("CONTEXT REMINDER"));
  assert.equal(reminder, undefined, "a 2-round run gets no reminder");
});

test("P5: buildContextReminder restates goal, targets, files modified, and last check state", () => {
  const text = buildContextReminder({
    goal: "Fix src/routes.ts",
    targetFiles: ["src/routes.ts"],
    filesWritten: ["src/routes.ts", "src/routes.ts"],
    lastChecks: { allPass: false, checks: [{ name: "test", command: "pnpm test", exitCode: 1, outputTail: "FAIL" }] },
  });
  assert.match(text, /GOAL: Fix src\/routes\.ts/);
  assert.match(text, /PRIMARY TARGET FILE\(S\): src\/routes\.ts/);
  assert.match(text, /FILES YOU HAVE MODIFIED SO FAR: src\/routes\.ts$/m, "deduped to one entry");
  assert.match(text, /LAST run_checks: FAILING \(test\)/);
});

// ── PRINCIPLE 6: SCHEMAS CARRY WORKED EXAMPLES ──────────────────────────────

test("P6: the core tool schemas carry concrete examples", () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  assert.match(byName.get("read_file")?.description ?? "", /Example: \{"path"/);
  assert.match(byName.get("write_file")?.description ?? "", /Example: \{"path".*"content"/);
  assert.match(byName.get("done")?.description ?? "", /Example: \{"satisfied"/);
  assert.match(byName.get("run_checks")?.description ?? "", /Example: \{\}/);
});
