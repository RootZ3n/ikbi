import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { commands } from "../../cli/registry.js";
import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/index.js";
import { createAgentRouter } from "./router.js";
import type { AgentRouter, AnswerResult } from "./contract.js";
// Importing cli.js registers the `classify`/`ask` commands at module load.
import { createRouterCli, parseProject } from "./cli.js";

const silent = () => pino({ level: "silent" });
const OPERATOR_TOKEN = "operator-token-thirty-two-chars-min-xyz";

/** A resolver with an operator agent the token maps to (the real identity path). */
function operatorResolver() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "operator", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken(OPERATOR_TOKEN)] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return (claim: { token?: string }) => resolver.resolve(claim);
}

function modelResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

/** A neutralize spy (core-compatible). */
function neutralizeSpy() {
  const calls: Array<{ content: string; context: UntrustedContext }> = [];
  const fn = (content: string, context: UntrustedContext): NeutralizedContent => {
    calls.push({ content, context });
    return { kind: "ikbi/neutralized-untrusted", contractVersion: "1.0.0", wrapped: `[NEUTRALIZED] <${content.length}>`, raw: content, body: content, scan: { verdict: "clean", recommendedAction: "allow", maxConfidence: 0, findings: [], scannedBytes: content.length, truncated: false }, source: context.source, fenceId: "f", bytes: content.length, defangApplied: false, defangedCount: 0, truncated: false, omittedBytes: 0 } as unknown as NeutralizedContent;
  };
  return { fn, calls };
}

const toUntrusted = (n: NeutralizedContent, opts?: { role?: "user" | "tool"; toolCallId?: string }) => ({ role: opts?.role ?? "user" as const, content: n.wrapped, untrusted: true });

/** Capture stdout/stderr/exit for a command run. */
function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

// ── registration (barrel / startup) ──────────────────────────────────────────

test("classify + ask are registered as CLI commands (no built-in collision)", () => {
  assert.ok(commands.has("classify"), "classify registered on import");
  assert.ok(commands.has("ask"), "ask registered on import");
  for (const name of ["version", "models", "providers", "help"]) {
    assert.notEqual(name, "classify");
    assert.notEqual(name, "ask");
  }
  const names = commands.all().map((c) => c.name);
  assert.ok(names.includes("classify") && names.includes("ask"), "both appear in the command listing");
});

// ── END-TO-END CHAIN (injected model — no network) ───────────────────────────

test("classify command runs the FULL chain: identity → neutralize → (fake) model → IntentResult", () => {
  const ne = neutralizeSpy();
  const sm: ModelRequest[] = [];
  const router = createAgentRouter({
    config: { enabled: true, maxMemoryEntries: 50 },
    invokeModel: async (req) => {
      sm.push(req);
      return modelResponse('{"intent":"build","target":"demo","confidence":0.9}');
    },
    neutralizeUntrusted: ne.fn,
    toUntrustedMessage: toUntrusted,
    publish: () => {},
  });
  const cap = capture();
  const cli = createRouterCli({ router, resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });

  return cli.classify(["build", "the", "demo", "project"]).then(() => {
    assert.equal(cap.exit, undefined, "success — exit code not set");
    assert.equal(cap.err, "", "no error output");
    assert.equal(sm.length, 1, "the (fake) model was invoked through the chain");
    assert.ok(ne.calls.some((c) => c.context.source === "external"), "the message was neutralized before the model");
    const parsed = JSON.parse(cap.out);
    assert.equal(parsed.intent, "build");
    assert.equal(parsed.target, "demo");
  });
});

// ── fail-closed: missing operator token ──────────────────────────────────────

test("classify fails closed with a friendly error when no operator token is set (no model call)", () => {
  let invoked = 0;
  const router = createAgentRouter({ config: { enabled: true, maxMemoryEntries: 50 }, invokeModel: async () => { invoked += 1; return modelResponse("{}"); }, neutralizeUntrusted: neutralizeSpy().fn, toUntrustedMessage: toUntrusted, publish: () => {} });
  const cap = capture();
  const cli = createRouterCli({ router, resolveIdentity: operatorResolver(), operatorToken: undefined, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });

  return cli.classify(["hello"]).then(() => {
    assert.equal(cap.exit, 1, "non-zero exit");
    assert.match(cap.err, /no operator identity.*IKBI_OPERATOR_TOKEN/, "clear actionable message");
    assert.equal(invoked, 0, "the model is never called without an identity");
    assert.equal(cap.out, "", "nothing on stdout");
  });
});

// ── fail-closed: model error (no raw stack) ──────────────────────────────────

test("classify reports a model/auth/network error cleanly (no raw stack leak)", () => {
  const router = createAgentRouter({ config: { enabled: true, maxMemoryEntries: 50 }, invokeModel: async () => { throw new Error("401 unauthorized: bad api key"); }, neutralizeUntrusted: neutralizeSpy().fn, toUntrustedMessage: toUntrusted, publish: () => {} });
  const cap = capture();
  const cli = createRouterCli({ router, resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });

  return cli.classify(["build", "it"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /model call failed:.*401 unauthorized/, "the error message is surfaced");
    assert.match(cap.err, /IKBI_MIMO_API_KEY/, "actionable guidance included");
    assert.ok(!cap.err.includes("\n    at "), "no raw stack frames leaked");
  });
});

// ── ask --project parsing + chain ────────────────────────────────────────────

test("parseProject extracts --project and --project=<name>", () => {
  assert.deepEqual(parseProject(["what", "--project", "demo", "happened"]), { project: "demo", rest: ["what", "happened"] });
  assert.deepEqual(parseProject(["q", "--project=alpha"]), { project: "alpha", rest: ["q"] });
  assert.deepEqual(parseProject(["just", "a", "question"]), { rest: ["just", "a", "question"] });
});

test("ask command threads the --project flag through to the router", () => {
  const seen: Array<{ question: string; project?: string }> = [];
  const router: AgentRouter = {
    classify: async () => ({ intent: "x" }),
    ask: async (input): Promise<AnswerResult> => {
      seen.push({ question: input.question, ...(input.project !== undefined ? { project: input.project } : {}) });
      return { answer: "answered", sources: [] };
    },
  };
  const cap = capture();
  const cli = createRouterCli({ router, resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });

  return cli.ask(["what", "happened", "--project", "demo"]).then(() => {
    assert.equal(cap.exit, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.question, "what happened");
    assert.equal(seen[0]?.project, "demo");
    assert.match(cap.out, /"answer": "answered"/);
  });
});

test("classify with an empty message fails closed (usage hint), no identity/model call", () => {
  let invoked = 0;
  const router = createAgentRouter({ config: { enabled: true, maxMemoryEntries: 50 }, invokeModel: async () => { invoked += 1; return modelResponse("{}"); }, neutralizeUntrusted: neutralizeSpy().fn, toUntrustedMessage: toUntrusted, publish: () => {} });
  const cap = capture();
  const cli = createRouterCli({ router, resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });

  return cli.classify([]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /needs a message/);
    assert.equal(invoked, 0);
  });
});
