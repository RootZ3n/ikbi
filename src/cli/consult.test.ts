/**
 * Tests for the `ikbi consult` CLI: arg parsing, operator gating, and output. runConsult and
 * identity are injected, so no model/network/identity registry is touched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createConsultCli, parseConsultArgs } from "./consult.js";
import type { ConsultCliDeps } from "./consult.js";
import type { ValidatedIdentity } from "../core/identity/index.js";
import type { ConsultRequest, ConsultResult } from "../modules/consult/index.js";

const fakeIdentity = { identity: { agentId: "op-1", functionalRole: "operator", trustTier: "operator" } } as unknown as ValidatedIdentity;

function fakeResult(over: Partial<ConsultResult> = {}): ConsultResult {
  return {
    modelId: "sonnet-4.6",
    tier: "frontier",
    mode: "advise",
    answer: "ROOT CAUSE: the guard is inverted.",
    packet: { evidence: { slices: [{}] }, truncation: { packetTruncated: false } } as unknown as ConsultResult["packet"],
    usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 } as unknown as ConsultResult["usage"],
    cost: { usd: 0.02 } as unknown as ConsultResult["cost"],
    retrieval: { files: 3, lowConfidence: false },
    ...over
  };
}

function harness(over: Partial<ConsultCliDeps> = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  let exit = 0;
  const calls: ConsultRequest[] = [];
  const cli = createConsultCli({
    resolveIdentity: () => fakeIdentity,
    operatorToken: "op-token",
    runConsult: async (req) => {
      calls.push(req);
      return fakeResult();
    },
    stdout: (s) => out.push(s),
    stderr: (s) => errs.push(s),
    setExit: (c) => {
      exit = c;
    },
    cwd: () => "/repo",
    ...over
  });
  return { cli, out, errs, calls, exit: () => exit };
}

test("parseConsultArgs: question + flags", () => {
  const a = parseConsultArgs(["why is auth broken?", "--repo", "/x", "--mode", "patch", "--model", "opus-4.8", "--json"]);
  assert.equal(a.question, "why is auth broken?");
  assert.equal(a.repo, "/x");
  assert.equal(a.mode, "patch");
  assert.equal(a.model, "opus-4.8");
  assert.equal(a.json, true);
});

test("parseConsultArgs: defaults to advise; flags an invalid --mode", () => {
  assert.equal(parseConsultArgs(["q"]).mode, "advise");
  assert.equal(parseConsultArgs(["q", "--mode", "wat"]).badMode, "wat");
});

test("runs a consult and prints the frontier answer + header", async () => {
  const h = harness();
  await h.cli.run(["why does auth accept empty tokens?", "--repo", "/repo"]);
  assert.equal(h.exit(), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.question, "why does auth accept empty tokens?");
  assert.equal(h.calls[0]!.mode, "advise");
  assert.equal(h.calls[0]!.identity, fakeIdentity.identity, "passes the AgentIdentity from the resolved operator");
  const printed = h.out.join("");
  assert.match(printed, /ROOT CAUSE/);
  assert.match(printed, /sonnet-4\.6 \(frontier\)/);
  assert.match(printed, /3 file\(s\)/);
});

test("--json emits structured output without the packet body", async () => {
  const h = harness();
  await h.cli.run(["q", "--json"]);
  const parsed = JSON.parse(h.out.join(""));
  assert.equal(parsed.modelId, "sonnet-4.6");
  assert.equal(parsed.answer, "ROOT CAUSE: the guard is inverted.");
  assert.equal(parsed.packet, undefined, "the raw packet is not dumped in --json");
});

test("--model override is threaded to runConsult", async () => {
  const h = harness();
  await h.cli.run(["q", "--model", "opus-4.8"]);
  assert.equal(h.calls[0]!.modelOverride, "opus-4.8");
});

test("requires a question", async () => {
  const h = harness();
  await h.cli.run(["--repo", "/repo"]);
  assert.equal(h.exit(), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.errs.join(""), /question is required/);
});

test("invalid --mode is rejected before any model call", async () => {
  const h = harness();
  await h.cli.run(["q", "--mode", "nonsense"]);
  assert.equal(h.exit(), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.errs.join(""), /invalid --mode/);
});

test("missing operator token fails closed", async () => {
  const h = harness({ operatorToken: undefined });
  await h.cli.run(["q"]);
  assert.equal(h.exit(), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.errs.join(""), /no operator identity/);
});
