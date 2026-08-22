/**
 * `ikbi local` — the operator surface.
 *
 * Two things are pinned here above all: an invocation ikbi cannot read is REFUSED rather than
 * guessed at, and an unqualified answer is labelled unqualified in the output an operator actually
 * reads. On the current deployment every artifact is unqualified, so a label that only appears in
 * `--json` is a label nobody sees.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLocalArgs, renderLocalResult, runLocalCli } from "./local.js";
import type { LocalLaneResult } from "../runtime/local-lane.js";

// ── parsing ─────────────────────────────────────────────────────────────────

test("local cli: a valid invocation parses", () => {
  const a = parseLocalArgs(["test_log_triage", "--instruction", "classify", "--file", "a.log"]);
  assert.equal(a.rejection, undefined);
  assert.equal(a.taskClass, "test_log_triage");
  assert.equal(a.mode, "assist", "ASSIST is the default — supervised, never autonomous");
});

test("local cli: an unknown task class is refused — every local task needs a validator", () => {
  const a = parseLocalArgs(["refactor_everything", "--instruction", "go"]);
  assert.match(a.rejection!, /unknown task class/);
});

test("local cli: an INELIGIBLE class is refused by name, not silently accepted", () => {
  for (const cls of ["autonomous_publication", "credential_handling", "broad_refactor"]) {
    assert.ok(parseLocalArgs([cls, "--instruction", "go"]).rejection !== undefined, `${cls} must be refused`);
  }
});

test("local cli: a missing instruction is refused", () => {
  assert.match(parseLocalArgs(["test_log_triage", "--file", "a.log"]).rejection!, /--instruction is required/);
});

test("local cli: EXACT without a named artifact is refused — nothing about it is exact", () => {
  assert.match(parseLocalArgs(["test_log_triage", "--instruction", "x", "--mode", "exact"]).rejection!, /requires --model/);
  assert.equal(parseLocalArgs(["test_log_triage", "--instruction", "x", "--mode", "exact", "--model", "m"]).rejection, undefined);
});

test("local cli: an unknown flag is refused rather than ignored", () => {
  assert.match(parseLocalArgs(["test_log_triage", "--instruction", "x", "--yolo"]).rejection!, /unknown flag/);
});

test("local cli: a bare extra word is refused — the question goes in --instruction", () => {
  assert.match(parseLocalArgs(["test_log_triage", "classify this", "--instruction", "x"]).rejection!, /--instruction/);
});

test("local cli: an invalid mode is refused with the valid set", () => {
  assert.match(parseLocalArgs(["test_log_triage", "--instruction", "x", "--mode", "yolo"]).rejection!, /assist\|auto/);
});

test("local cli: every mode is accepted", () => {
  for (const mode of ["off", "assist", "auto"]) {
    assert.equal(parseLocalArgs(["test_log_triage", "--instruction", "x", "--mode", mode]).rejection, undefined);
  }
});

// ── rendering ───────────────────────────────────────────────────────────────

const base = {
  decision: { offload: true, mode: "assist", taskClass: "test_log_triage", reason: "eligible", explanation: "eligible", requireQualified: false, fallbackPermitted: false },
  attempts: [{ attempt: 1, outcome: "ROUTED", detail: "ok", latencyMs: 900, promptTokens: 400, completionTokens: 30 }],
  retryCount: 0, addedLatencyMs: 0, partialOutputDiscarded: false, detail: "ok",
} as unknown as LocalLaneResult;

test("local cli: an UNQUALIFIED result is labelled supervised in the HUMAN output", () => {
  const out = renderLocalResult({
    ...base, accepted: true, artifact: { category: "flaky" },
    supervision: { executionClass: "local", qualified: false, humanReviewRequired: true, autonomousPromotionAllowed: false, reason: "reported INSTALLED_UNQUALIFIED" },
    servedIdentity: { modelId: "qwen3.5-35b-a3b.q2-k", artifactDigest: "sha256:4953", qualificationStatus: "INSTALLED_UNQUALIFIED" },
  } as unknown as LocalLaneResult);
  assert.match(out, /SUPERVISED-LOCAL/);
  assert.match(out, /Human review required/);
  assert.match(out, /may not be promoted autonomously/);
});

test("local cli: the EXACT served artifact and digest are shown, not just the model name", () => {
  const out = renderLocalResult({
    ...base, accepted: true, artifact: {},
    servedIdentity: { modelId: "qwen3.5-35b-a3b.q2-k", artifactDigest: "sha256:4953", qualificationStatus: "INSTALLED_UNQUALIFIED" },
  } as unknown as LocalLaneResult);
  assert.match(out, /qwen3\.5-35b-a3b\.q2-k/);
  assert.match(out, /sha256:4953/);
});

test("local cli: measurable local work is reported — attempts, latency, tokens", () => {
  const out = renderLocalResult({ ...base, accepted: true, artifact: {} } as unknown as LocalLaneResult);
  assert.match(out, /attempts    1/);
  assert.match(out, /900ms local/);
  assert.match(out, /430 local token\(s\)/);
});

test("local cli: a DISCARDED answer says so", () => {
  const out = renderLocalResult({ ...base, accepted: false, rejection: "citation_unresolved", detail: "invented", partialOutputDiscarded: true } as unknown as LocalLaneResult);
  assert.match(out, /NOT ACCEPTED — citation_unresolved/);
  assert.match(out, /DISCARDED/);
});

test("local cli: the decision and its reason appear even when nothing ran", () => {
  const out = renderLocalResult({
    ...base, decision: { ...base.decision, offload: false, reason: "mode_off", explanation: "local mode is OFF — no request is made to Bokahli" },
    accepted: false, attempts: [],
  } as unknown as LocalLaneResult);
  assert.match(out, /mode_off/);
  assert.match(out, /no request is made to Bokahli/);
});

// ── end to end, with the lane injected ──────────────────────────────────────

test("local cli: OFF exits non-zero and never reaches a model", async () => {
  let transportMade = 0;
  let out = "";
  const code = await runLocalCli(
    ["test_log_triage", "--instruction", "x", "--file", "a.log", "--mode", "off"],
    {
      stdout: (s) => (out += s), stderr: () => undefined,
      readFile: () => "FAIL something\n",
      makeTransport: () => { transportMade += 1; return undefined; },
    },
  );
  assert.equal(code, 1, "a refusal is an answer, and a script must be able to tell");
  assert.match(out, /mode_off/);
  // The transport factory may be consulted, but no local request can result from OFF.
  assert.ok(transportMade <= 1);
});

test("local cli: a packet with no files is refused before anything is constructed", async () => {
  let err = "";
  const code = await runLocalCli(["test_log_triage", "--instruction", "x"], { stderr: (s) => (err += s), stdout: () => undefined });
  assert.equal(code, 2);
  assert.match(err, /at least one --file is required/);
});

test("local cli: an unreadable file is a clean refusal, not a crash", async () => {
  let err = "";
  const code = await runLocalCli(
    ["test_log_triage", "--instruction", "x", "--file", "/nope/missing.log"],
    { stderr: (s) => (err += s), stdout: () => undefined, readFile: () => { throw new Error("ENOENT"); } },
  );
  assert.equal(code, 2);
  assert.match(err, /cannot read/);
});

test("local cli: --json emits the whole accounting record", async () => {
  let out = "";
  await runLocalCli(
    ["test_log_triage", "--instruction", "x", "--file", "a.log", "--json"],
    {
      stdout: (s) => (out += s), stderr: () => undefined, readFile: () => "FAIL x\n",
      makeTransport: () => undefined,
      runLane: async () => ({ ...base, accepted: false, rejection: "refused", attempts: [] }) as unknown as LocalLaneResult,
    },
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision.reason, "eligible");
  assert.equal(parsed.rejection, "refused");
});

test("local cli: naming an artifact REQUIRES attestation of what actually served it", async () => {
  let seen: Record<string, unknown> | undefined;
  await runLocalCli(
    ["test_log_triage", "--instruction", "x", "--file", "a.log", "--mode", "exact", "--model", "gemma4-12b.q6-k"],
    {
      stdout: () => undefined, stderr: () => undefined, readFile: () => "FAIL x\n",
      makeTransport: () => undefined,
      runLane: async (r) => { seen = r as unknown as Record<string, unknown>; return { ...base, accepted: false, attempts: [] } as unknown as LocalLaneResult; },
    },
  );
  // An EXACT request that would accept an unattested answer has not been exact about anything.
  assert.equal(seen!["requireAttestation"], true);
  assert.equal(seen!["expectedModelId"], "gemma4-12b.q6-k");
});

test("local cli: the packet handed to the lane is exactly the files named, fenced downstream", async () => {
  let seen: Record<string, unknown> | undefined;
  await runLocalCli(
    ["test_log_triage", "--instruction", "x", "--file", "a.log", "--file", "b.log"],
    {
      stdout: () => undefined, stderr: () => undefined, readFile: (p) => `content of ${p}\n`,
      makeTransport: () => undefined,
      runLane: async (r) => { seen = r as unknown as Record<string, unknown>; return { ...base, accepted: false, attempts: [] } as unknown as LocalLaneResult; },
    },
  );
  const packet = seen!["packet"] as { id: string; content: string }[];
  assert.deepEqual(packet.map((p) => p.id), ["a.log", "b.log"]);
  assert.equal(packet[0]!.content, "content of a.log\n");
});
