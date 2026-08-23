/**
 * Patchsmith builder lane — the SAFETY rails that make a tool-free diff generator
 * trustworthy: no tools in the request, verification gates the outcome, malformed and
 * forbidden patches fail closed, a partial pass never promotes, and repair sees the
 * verifier output.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import type { AgentIdentity, TrustTier } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { ExecRequest, ExecResult } from "../governed-exec/index.js";
import type { Check, ChecksResolution } from "./checks.js";
import { applyFilePatch, createPatchsmith, parseUnifiedDiff } from "./patchsmith.js";
import type { RoleContext, RoleEngine } from "./contract.js";

const PARENT_CTX: OperationContext = (() => {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "parent-1", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken("parent-secret")] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "parent-secret" }), { requestId: "req-1" });
})();

function base(): Omit<ModelResponse, "content" | "finishReason"> {
  return {
    contractVersion: "1.1.0", model: "deepseek-v4-flash", provider: "deepseek", providerModelId: "deepseek-v4-flash",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}
const textResp = (content: string): ModelResponse => ({ ...base(), content, finishReason: "stop" });

function mockEngine(responses: ModelResponse[]) {
  const requests: ModelRequest[] = [];
  const neutralized: Array<{ content: string; source: string }> = [];
  let i = 0;
  const engine: RoleEngine = {
    // Snapshot messages — the patchsmith mutates one live array across attempts, so storing the
    // reference would make every captured request show the FINAL conversation.
    invokeModel: async (req) => { requests.push({ ...req, ...(req.messages !== undefined ? { messages: [...req.messages] } : {}) }); const r = responses[Math.min(i, responses.length - 1)]; i += 1; return r ?? textResp(""); },
    neutralizeUntrusted: (content, context) => { neutralized.push({ content, source: context.source }); return coreNeutralize(content, context); },
  };
  return { engine, requests, neutralized };
}

/** A resolveChecks that always returns a single named check (so the default pnpm set is unused). */
const oneCheck = (name = "test"): ((ws: string) => ChecksResolution) => () => ({ ok: true, checks: [{ name, command: "echo", args: ["x"] } as Check], source: "default" });

/** Governed exec stub: exit 0 (green) for all checks. */
const greenExec = () => ({ run: async (_req: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }) });
/** Governed exec stub: exit 1 (red) carrying a recognizable failure string. */
const redExec = (msg = "AssertionError: add broken") => ({ run: async (_req: ExecRequest): Promise<ExecResult> => ({ executed: true, exitCode: 1, stdoutTail: msg, stderrTail: "" }) });

function makeCtx(dir: string, tier: TrustTier, engine: RoleEngine, taskExtra: Record<string, unknown> = {}): RoleContext {
  const identity: AgentIdentity = { agentId: "worker-1", functionalRole: "builder", trustTier: tier, spawnedFrom: "parent-1" };
  const workspace: WorkspaceHandle = { id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1", path: dir, identity, state: "allocated", createdAt: 0 };
  return {
    task: { taskId: "t-1", targetRepo: dir, goal: "Fix add in src/math.ts so it returns a + b", ...taskExtra },
    role: "builder", identity, autonomy: autonomyForTier(tier), workspace, priorResults: [], engine,
  };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "ikbi-patchsmith-"));

/** A well-formed unified diff that fixes src/math.ts. */
const GOOD_DIFF = "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a - b;\n+  return a + b;\n }\n";

test("patchsmith: cannot call tools — no tool schema in the model request", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  const { engine, requests } = mockEngine([textResp(GOOD_DIFF)]);
  await createPatchsmith({ governedExec: greenExec(), parentCtx: PARENT_CTX, resolveChecks: oneCheck() })(makeCtx(dir, "verified", engine));
  assert.ok(requests.length > 0, "the model was invoked");
  for (const r of requests) assert.equal(r.tools, undefined, "patchsmith must never send a tool schema");
});

test("patchsmith: runs verification before reporting success (cannot promote without verification)", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  let checkRuns = 0;
  const exec = { run: async (_req: ExecRequest): Promise<ExecResult> => { checkRuns += 1; return { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" }; } };
  const { engine } = mockEngine([textResp(GOOD_DIFF)]);
  const result = await createPatchsmith({ governedExec: exec, parentCtx: PARENT_CTX, resolveChecks: oneCheck() })(makeCtx(dir, "verified", engine));
  const detail = result.detail as Record<string, unknown>;
  assert.equal(result.outcome, "success");
  assert.equal(detail.verificationResult, "pass");
  assert.ok(checkRuns >= 1, "verification (governed checks) ran before success");
  // The patch landed on disk.
  assert.match(readFileSync(join(dir, "src/math.ts"), "utf8"), /return a \+ b/);
});

test("patchsmith: no parent identity → fails closed (verification cannot run, no success)", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  const { engine } = mockEngine([textResp(GOOD_DIFF)]);
  // No parentCtx wired → checks unavailable → cannot go green.
  const result = await createPatchsmith({ governedExec: greenExec(), resolveChecks: oneCheck() })(makeCtx(dir, "verified", engine));
  assert.notEqual(result.outcome, "success");
  assert.equal((result.detail as Record<string, unknown>).verificationResult, "not_run");
});

test("patchsmith: malformed patch fails closed", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  const { engine } = mockEngine([textResp("here is your fix: change minus to plus, trust me!"), textResp("still no diff sorry")]);
  const result = await createPatchsmith({ governedExec: greenExec(), parentCtx: PARENT_CTX, resolveChecks: oneCheck() })(makeCtx(dir, "verified", engine));
  assert.equal(result.outcome, "failure");
  const detail = result.detail as { rejectedPatches?: Array<{ error: string }>; stopReason?: string };
  assert.ok((detail.rejectedPatches ?? []).length > 0, "the malformed patch was recorded as rejected");
  // The file was NOT modified.
  assert.match(readFileSync(join(dir, "src/math.ts"), "utf8"), /return a - b/);
});

test("patchsmith: a patch that changes a forbidden file is rejected (whole patch, no partial apply)", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  writeFileSync(join(dir, "src/math.test.ts"), "import { add } from './math.js';\nif (add(2,3)!==5) throw new Error('x');\n");
  // The model "cheats" by editing the test to make it pass.
  const cheatDiff = "--- a/src/math.test.ts\n+++ b/src/math.test.ts\n@@ -1,2 +1,2 @@\n import { add } from './math.js';\n-if (add(2,3)!==5) throw new Error('x');\n+if (false) throw new Error('x');\n";
  const { engine } = mockEngine([textResp(cheatDiff)]);
  const result = await createPatchsmith({ governedExec: greenExec(), parentCtx: PARENT_CTX, resolveChecks: oneCheck() })(makeCtx(dir, "verified", engine));
  assert.equal(result.outcome, "rejected");
  const detail = result.detail as { rejectedPatches?: Array<{ error: string }>; filesChanged?: string[] };
  assert.ok((detail.rejectedPatches ?? []).some((r) => /forbidden|off-limits/.test(r.error)), "forbidden-file violation recorded");
  assert.deepEqual(detail.filesChanged, [], "no file was written");
  // The test file is untouched.
  assert.match(readFileSync(join(dir, "src/math.test.ts"), "utf8"), /add\(2,3\)!==5/);
});

test("Phase 3: patchsmith refuses an existing target that was not observed before the model call", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export const math = 1;\n");
  writeFileSync(join(dir, "src/other.ts"), "export const other = 1;\n");
  const unboundTargetDiff = "--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,1 +1,1 @@\n-export const other = 1;\n+export const other = 2;\n";
  const { engine } = mockEngine([textResp(unboundTargetDiff)]);
  const result = await createPatchsmith({ governedExec: greenExec(), parentCtx: PARENT_CTX, resolveChecks: oneCheck() })(
    makeCtx(dir, "verified", engine, { metadata: { contextFiles: ["src/math.ts"] } }),
  );
  const detail = result.detail as { filesChanged?: readonly string[]; rejectedPatches?: readonly { error: string }[] };
  assert.notEqual(result.outcome, "success");
  assert.deepEqual(detail.filesChanged, []);
  assert.ok((detail.rejectedPatches ?? []).some((entry) => /not observed before the model call/.test(entry.error)));
  assert.equal(readFileSync(join(dir, "src/other.ts"), "utf8"), "export const other = 1;\n");
});

test("patchsmith: target check passes but full verification fails → does NOT promote", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  // Two checks: the FIRST (target test) is green, the SECOND (typecheck) is RED.
  const resolveTwo = (): ChecksResolution => ({ ok: true, checks: [{ name: "test", command: "echo", args: ["x"] }, { name: "typecheck", command: "tsc", args: ["x"] }], source: "default" });
  const exec = {
    run: async (req: ExecRequest): Promise<ExecResult> =>
      req.purpose?.includes("typecheck")
        ? { executed: true, exitCode: 1, stdoutTail: "error TS2322: Type 'string' is not assignable to type 'number'.", stderrTail: "" }
        : { executed: true, exitCode: 0, stdoutTail: "ok", stderrTail: "" },
  };
  // Only one patch + one repair (which also leaves typecheck red).
  const { engine } = mockEngine([textResp(GOOD_DIFF), textResp(GOOD_DIFF)]);
  const result = await createPatchsmith({ governedExec: exec, parentCtx: PARENT_CTX, resolveChecks: resolveTwo })(makeCtx(dir, "verified", engine));
  assert.notEqual(result.outcome, "success");
  assert.equal((result.detail as Record<string, unknown>).verificationResult, "fail");
});

test("patchsmith: repair attempt receives the verifier output", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  // First patch applies but verification is RED (carrying a recognizable marker), forcing a repair.
  const exec = redExec("UNIQUE_VERIFIER_MARKER_42: add still broken");
  const { engine, requests } = mockEngine([textResp(GOOD_DIFF), textResp(GOOD_DIFF)]);
  const result = await createPatchsmith({ governedExec: exec, parentCtx: PARENT_CTX, resolveChecks: oneCheck() })(makeCtx(dir, "verified", engine));
  // A repair happened.
  assert.equal((result.detail as Record<string, unknown>).repairAttempts, 1);
  assert.equal(requests.length, 2, "the model was called twice (initial + repair)");
  // The repair request carries the verifier output.
  const repairText = JSON.stringify(requests[1]!.messages);
  assert.match(repairText, /UNIQUE_VERIFIER_MARKER_42/);
  assert.match(repairText, /verification FAILED/i);
});

test("patchsmith: ladder-as-gate-wall — probation (sandboxed) patches under the ladder, not refused", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  const { engine, requests } = mockEngine([textResp(GOOD_DIFF)]);
  // probation ⇒ requiresApproval:true but sandboxed:true — proceeds (worktree-local, ladder-gated, no auto-commit).
  const result = await createPatchsmith({ governedExec: greenExec(), parentCtx: PARENT_CTX, resolveChecks: oneCheck() })(makeCtx(dir, "probation", engine));
  assert.ok(requests.length >= 1, "proceeded to the model (no longer blocked at the autonomy gate)");
  assert.notEqual((result.detail as { stopReason?: string }).stopReason, "approval_required", "not an approval rejection");
});

test("patchsmith: requiresApproval WITHOUT a sandbox → fail-closed, no model call", async () => {
  const dir = tmp();
  mkdirp(dir, "src");
  writeFileSync(join(dir, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  const { engine, requests } = mockEngine([textResp(GOOD_DIFF)]);
  const baseCtx = makeCtx(dir, "probation", engine);
  const ctx: RoleContext = { ...baseCtx, autonomy: { ...baseCtx.autonomy, sandboxed: false } };
  const result = await createPatchsmith({ governedExec: greenExec(), parentCtx: PARENT_CTX, resolveChecks: oneCheck() })(ctx);
  assert.equal(result.outcome, "rejected");
  assert.equal(requests.length, 0, "no model call when approval is required without a sandbox");
});

// ── helpers ──
import { mkdirSync } from "node:fs";
function mkdirp(dir: string, sub: string): void {
  mkdirSync(join(dir, sub), { recursive: true });
}

// ── Phase 3: drifted context never receives invisible relocation authority ──

test("Phase 3: a drifted hunk is rejected even when its before-block is ambiguous", () => {
  const original = "foo\ntarget\nbar\ntarget\nbaz\n";
  // oldStart=1 (hint → line 0 = "foo") does not match the "target" before-block.
  // Phase 3 deliberately removed the former drifted-context scan: ambiguity is refusal.
  const parsed = parseUnifiedDiff("--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-target\n+TARGET\n");
  assert.equal(parsed.ok, true);
  const patch = parsed.ok ? parsed.files[0]! : undefined;
  assert.ok(patch);
  const res = applyFilePatch(original, patch);
  assert.equal(res.ok, false, "non-unique drifted context must not be spliced");
  if (!res.ok) assert.match(res.error, /stale|relocation/i, "the error explicitly reports stale state rather than granting relocation authority");
});

test("Phase 3: a drifted hunk is rejected even when its before-block is unique", () => {
  const original = "foo\ntarget\nbar\nqux\nbaz\n";
  // "target" is unique, but uniqueness is diagnostic evidence only; it does not authorize relocation.
  const parsed = parseUnifiedDiff("--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-target\n+TARGET\n");
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const res = applyFilePatch(original, parsed.files[0]!);
  assert.equal(res.ok, false, "a unique match is diagnostic evidence only; it cannot silently relocate a stale hunk");
  if (!res.ok) assert.match(res.error, /stale|relocation/i);
});

test("Phase 3: an out-of-range insertion is stale rather than clamped", () => {
  const parsed = parseUnifiedDiff("--- a/f.txt\n+++ b/f.txt\n@@ -99,0 +99,1 @@\n+inserted\n");
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const res = applyFilePatch("one\ntwo\n", parsed.files[0]!);
  assert.equal(res.ok, false, "an insertion beyond the observed file must not be relocated to its end");
  if (!res.ok) assert.match(res.error, /stale|relocation/i);
});
