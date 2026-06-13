/**
 * SG-1 (audit): governed-exec streams stdout/stderr to a live sink chunk-by-chunk as it runs
 * (when request.onOutput is set), while the ExecResult still carries only the bounded tail for
 * logging/receipts. Without onOutput, the buffered path is unchanged.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { beginOperation, IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { OperationContext } from "../../core/identity/resolver.js";
import { createGateWall } from "../gate-wall/index.js";
import { OUTPUT_TAIL_CHARS } from "./config.js";
import { createGovernedExec, type ExecFileFn, type ExecFileStreamFn } from "./exec.js";
import type { GovernedExecConfig } from "./config.js";

const silent = () => pino({ level: "silent" });
function makeCtx(tier = "verified"): OperationContext {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "caller-1", kind: "agent", defaultTrustTier: tier, tokenHashes: [hashToken("caller-secret")] }] }),
    logger: silent(), now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: "caller-secret" }), { requestId: "req-1" });
}
const cfg = (allowlist: string[]): GovernedExecConfig => ({ enabled: true, allowlist, execTimeoutMs: 1000, maxBuffer: 1_000_000, networkTimeoutMs: 1000 });
const gate = () => createGateWall({ receipts: { append: async () => ({}) }, publish: () => {} });
const noReceipts = { append: async () => ({}) };

test("onOutput STREAMS each chunk live as it arrives; the result tail is still bounded", async () => {
  // A streaming primitive that emits several chunks (simulating output arriving over time).
  const chunks = ["compiling…\n", "running tests…\n", "x".repeat(OUTPUT_TAIL_CHARS + 500), "\nall green\n"];
  const streamFn: ExecFileStreamFn = async (_b, _a, _o, onOutput) => {
    let full = "";
    for (const c of chunks) {
      onOutput(c, "stdout");
      full += c;
    }
    return { stdout: full, stderr: "", code: 0 };
  };
  const live: string[] = [];
  const ge = createGovernedExec({ config: cfg(["pnpm"]), gateWall: gate(), execFileStream: streamFn, receipts: noReceipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx(), command: "pnpm", args: ["test"], purpose: "verifier check: test", onOutput: (c) => live.push(c) });

  assert.equal(r.executed, true);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(live, chunks, "every chunk reached the live sink, in order, untruncated");
  // The RECEIPT/result tail is still bounded — truncation is for the record, not the live view.
  assert.ok((r.stdoutTail?.length ?? 0) <= OUTPUT_TAIL_CHARS, `tail is bounded to ${OUTPUT_TAIL_CHARS}`);
  assert.ok((r.stdoutTail ?? "").endsWith("all green\n"), "the tail keeps the END of the stream");
});

test("a streamed non-zero exit is reported (not thrown), with the bounded tail", async () => {
  const streamFn: ExecFileStreamFn = async (_b, _a, _o, onOutput) => {
    onOutput("boom\n", "stderr");
    return { stdout: "", stderr: "boom\n", code: 2 };
  };
  const ge = createGovernedExec({ config: cfg(["pnpm"]), gateWall: gate(), execFileStream: streamFn, receipts: noReceipts, publish: () => {} });
  const r = await ge.run({ parentCtx: makeCtx(), command: "pnpm", args: ["test"], purpose: "verifier check: test", onOutput: () => {} });
  assert.equal(r.executed, true);
  assert.equal(r.exitCode, 2);
  assert.match(r.reason ?? "", /exited 2/);
  assert.equal(r.stderrTail, "boom\n");
});

test("ISSUE-5: a check emitting >maxBuffer output streams without ENOBUFS and reports the real exit code (no false RED)", async () => {
  // The buffered execFile path throws ENOBUFS once stdout passes maxBuffer → a false exit-1 RED on a
  // PASSING but verbose suite. The streaming path caps CAPTURE at maxBuffer WITHOUT killing the
  // process, so the real exit 0 survives and the recorded tail stays bounded.
  const huge = "x".repeat(2_000_000); // 2MB > the 1MB maxBuffer in cfg()
  const streamFn: ExecFileStreamFn = async (_b, _a, opts, onOutput) => {
    onOutput(huge, "stdout"); // delivered live, untruncated
    return { stdout: huge.slice(0, opts.maxBuffer), stderr: "", code: 0 }; // capture bounded, exit preserved
  };
  const ge = createGovernedExec({ config: cfg(["pnpm"]), gateWall: gate(), execFileStream: streamFn, receipts: noReceipts, publish: () => {} });
  const r = await ge.run({ parentCtx: makeCtx(), command: "pnpm", args: ["test"], purpose: "verifier check: test", onOutput: () => {} });
  assert.equal(r.executed, true);
  assert.equal(r.exitCode, 0, "a verbose passing suite is NOT mapped to a false RED");
  assert.ok((r.stdoutTail?.length ?? 0) <= OUTPUT_TAIL_CHARS, "the captured tail is still bounded");
});

test("WITHOUT onOutput the buffered execFile path is used (streaming primitive untouched)", async () => {
  let streamed = false;
  const streamFn: ExecFileStreamFn = async () => { streamed = true; return { stdout: "", stderr: "", code: 0 }; };
  const bufFn: ExecFileFn = async () => ({ stdout: "buffered out", stderr: "" });
  const ge = createGovernedExec({ config: cfg(["git"]), gateWall: gate(), execFile: bufFn, execFileStream: streamFn, receipts: noReceipts, publish: () => {} });

  const r = await ge.run({ parentCtx: makeCtx(), command: "git", args: ["status"] }); // no onOutput
  assert.equal(r.executed, true);
  assert.equal(r.stdoutTail, "buffered out");
  assert.equal(streamed, false, "the streaming primitive is NOT used without onOutput (buffered path unchanged)");
});
