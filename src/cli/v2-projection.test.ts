/**
 * OPERATOR PROJECTIONS OVER v2 RECEIPTS.
 *
 * Both defects here have the same shape: a projection written for the v1 worker-model was never
 * taught the canonical engine's vocabulary, and instead of saying nothing it said something
 * FALSE. `ikbi receipts --task` reported "verification: (not run)" for runs whose checks had
 * demonstrably run — and, in the preserved Apela case, had run and failed. An absence reported as
 * a finding is worse than silence, because a reader acts on it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createReceiptsCli } from "./receipts.js";
import { inspectRun, INSPECT_EXIT_CODES } from "./inspect.js";

const V2_ID: AgentIdentity = { agentId: "ikbi-v2", trustTier: "trusted" };

function rec(over: Partial<Receipt> & { seq: number; operation: string; status: Receipt["outcome"]["status"] }): Receipt {
  return {
    contractVersion: "1.0.0", id: `r${over.seq}`, seq: over.seq,
    timestamp: 1_700_000_000_000 + over.seq * 1000,
    identity: over.identity ?? V2_ID, operation: over.operation,
    outcome: { status: over.status, ...(over.outcome?.detail !== undefined ? { detail: over.outcome.detail } : {}) },
    changes: [],
    ...(over.requestId !== undefined ? { requestId: over.requestId } : {}),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
    ...(over.project !== undefined ? { project: over.project } : {}),
  } as Receipt;
}

function store(list: readonly Receipt[]) {
  return { receipts: { query: async (_f: ReceiptQuery = {}): Promise<Receipt[]> => [...list] } };
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

const RUN = "run_5cd03091-234e-49ae-bf6e-193d497b1ac6";
const TASK = "task_bf736eb6-b706-4355-ad64-36742cf625f1";
const SESSION = "sess_2c5ade57-b868-48c3-b537-4213b2b98376";

/** A v2 `run.summary` in exactly the shape the engine writes. */
function v2Summary(over: Record<string, unknown> = {}, status: Receipt["outcome"]["status"] = "failure"): Receipt {
  return rec({
    seq: 10,
    operation: "run.summary",
    status,
    requestId: RUN,
    project: "/repo",
    metadata: {
      engine: "v2", runId: RUN, taskId: TASK, buildSessionId: SESSION,
      status: "withheld", phase: "terminal", attempts: 2,
      verification: "pass", verificationResult: "pass",
      verificationId: "a903c8f2b73e22fcfdd690ffc2fd5f6736b0a4f1d2d31a2adde609479be2ebd8",
      promotion: "not_attempted", promoted: false, repository: "/repo",
      ...over,
    },
  });
}

// ---------------------------------------------------------------------------
// receipts --task
// ---------------------------------------------------------------------------

test("receipts --task reports a v2 verification that RAN and PASSED", async () => {
  const io = capture();
  const { receipts: cli } = createReceiptsCli({ ...store([v2Summary()]), ...io });
  await cli(["--task", TASK]);

  assert.doesNotMatch(io.out, /verification: \(not run\)/, "the false 'not run' is gone");
  assert.match(io.out, /verification: pass/);
  assert.match(io.out, /a903c8f2b73e/, "and cites the verification it is reporting");
});

test("receipts --task reports a v2 verification that RAN and FAILED", async () => {
  const io = capture();
  const { receipts: cli } = createReceiptsCli({ ...store([v2Summary({ verification: "fail", verificationResult: "fail" })]), ...io });
  await cli(["--task", TASK]);

  assert.match(io.out, /verification: fail/, "a red verification must be visible, not reported as absent");
  assert.doesNotMatch(io.out, /\(not run\)/);
});

test("receipts --task still says (not run) when verification GENUINELY did not run", async () => {
  const io = capture();
  const noVerification = rec({
    seq: 10, operation: "run.summary", status: "failure", requestId: RUN,
    metadata: { engine: "v2", runId: RUN, taskId: TASK, status: "failed", phase: "preflight" },
  });
  const { receipts: cli } = createReceiptsCli({ ...store([noVerification]), ...io });
  await cli(["--task", TASK]);

  assert.match(io.out, /verification: \(not run\)/, "the honest case still reads honestly");
});

test("receipts --task surfaces the run id, outcome and attempt count from a v2 summary", async () => {
  const io = capture();
  const { receipts: cli } = createReceiptsCli({ ...store([v2Summary()]), ...io });
  await cli(["--task", TASK]);

  assert.match(io.out, new RegExp(`run: ${RUN}`), "the id `ikbi inspect` takes");
  assert.match(io.out, /outcome: withheld \(terminal\)/);
  assert.match(io.out, /attempts: 2/);
  assert.match(io.out, /repo: \/repo/);
});

test("receipts --task reports a v2 promotion state when there is no workspace.promote receipt", async () => {
  const io = capture();
  const { receipts: cli } = createReceiptsCli({ ...store([v2Summary()]), ...io });
  await cli(["--task", TASK]);
  assert.match(io.out, /promote: not_attempted \(via run summary\)/);
});

test("receipts --task leaves the v1 worker-model projection working", async () => {
  const io = capture();
  const v1 = [
    rec({ seq: 1, operation: "worker.role.verifier", status: "success", requestId: "task_v1", metadata: { taskId: "task_v1", role: "verifier" } }),
    rec({ seq: 2, operation: "worker.run.summary", status: "success", requestId: "task_v1", metadata: { taskId: "task_v1", targetRepo: "/legacy", model: "m1" } }),
  ];
  const { receipts: cli } = createReceiptsCli({ ...store(v1), ...io });
  await cli(["--task", "task_v1"]);

  assert.match(io.out, /verification: success/, "the v1 role receipt is still the fallback");
  assert.match(io.out, /repo: \/legacy/);
  assert.match(io.out, /model: m1/);
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test("inspect resolves the canonical RUN id", async () => {
  const result = await inspectRun(RUN, { readReceipts: async () => [v2Summary()] });
  assert.equal(result.status, "found");
  assert.equal(result.runId, RUN);
  assert.equal(result.taskId, TASK);
  assert.equal(result.exitCode, INSPECT_EXIT_CODES.ok);
});

test("inspect ALSO resolves a build-SESSION id, and answers with the canonical run id", async () => {
  // The session id is the most prominent thing in the operator JSON, so it is what gets pasted.
  const result = await inspectRun(SESSION, { readReceipts: async () => [v2Summary()] });
  assert.equal(result.status, "found", "a session id must not read as 'no such run'");
  assert.equal(result.runId, RUN, "and the answer names the id the log is actually keyed by");
});

test("inspect on a session with SEVERAL attempts resolves the FINAL one", async () => {
  const first = v2Summary({ runId: "run_first-0000-0000-0000-000000000000" });
  const finalRun = v2Summary();
  const result = await inspectRun(SESSION, { readReceipts: async () => [first, finalRun] });
  assert.equal(result.runId, RUN, "the last run.summary of the session is the canonical one");
});

test("inspect still refuses an id that matches nothing", async () => {
  const result = await inspectRun("run_nope-0000-0000-0000-000000000000", { readReceipts: async () => [v2Summary()] });
  assert.equal(result.status, "not_found");
  assert.equal(result.exitCode, INSPECT_EXIT_CODES.missing);
  assert.match(result.recovery.join(" "), /run or build-session id/);
});

test("a v2 run is discoverable by its RUN id and its SESSION id, not only its task id", async () => {
  // The third defect in this family: `--task` keyed off `requestId` first, which for a v2
  // run.summary is the RUN id — so the TASK id, the thing the flag is named for, matched nothing.
  for (const id of [TASK, RUN, SESSION]) {
    const io = capture();
    const { receipts: cli } = createReceiptsCli({ ...store([v2Summary()]), ...io });
    await cli(["--task", id]);
    assert.match(io.out, /verification: pass/, `${id} did not resolve the trail`);
    assert.equal(io.err, "", `${id} reported "no receipts found"`);
  }
});
