import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { IdentityResolver } from "../../core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { createMcpCli, parseMcpArgs, splitServerCommand } from "./cli.js";
import type { McpLoopRequest, McpLoopResult, McpModelLoop, McpTransport } from "./contract.js";

const silent = () => pino({ level: "silent" });
const OPERATOR_TOKEN = "operator-token-value";

function operatorResolver() {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId: "operator", kind: "operator", defaultTrustTier: "operator", tokenHashes: [hashToken(OPERATOR_TOKEN)] }] }),
    logger: silent(),
    now: () => 1000,
  });
  return (claim: { token?: string }) => resolver.resolve(claim);
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return { stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s), setExit: (c: number) => void (exit = c), get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

const okResult = (over: Partial<McpLoopResult> = {}): McpLoopResult =>
  ({ completed: true, rounds: 2, stopReason: "stop", neutralizedCount: 1, gatedCalls: 1, deniedCalls: 0, content: "done", ...over });

/** A fake transport (never spawns) + a fake loop that records the request it ran. */
function fakeWiring(result: McpLoopResult) {
  const transports: Array<{ command: string; args: string[] }> = [];
  const requests: McpLoopRequest[] = [];
  const transport = { connect: async () => {}, listTools: async () => [], callTool: async () => "", close: async () => {} } satisfies McpTransport;
  const createTransport = (opts: { command: string; args: string[] }): McpTransport => { transports.push(opts); return transport; };
  const createLoop = (_t: McpTransport): McpModelLoop => ({ run: async (req) => { requests.push(req); return result; } });
  return { transports, requests, createTransport, createLoop };
}

// ── arg parsing (pure) ────────────────────────────────────────────────────────

test("parseMcpArgs extracts --server / --model; the rest is the goal", () => {
  assert.deepEqual(parseMcpArgs(["--server", "npx srv", "do", "a", "thing"]), { server: "npx srv", rest: ["do", "a", "thing"] });
  assert.deepEqual(parseMcpArgs(["--server=cmd", "--model=m1", "go"]), { server: "cmd", model: "m1", rest: ["go"] });
  assert.deepEqual(parseMcpArgs(["just", "a", "goal"]), { rest: ["just", "a", "goal"] });
});

test("splitServerCommand splits executable + args on whitespace", () => {
  assert.deepEqual(splitServerCommand("npx -y @scope/server /tmp"), { command: "npx", args: ["-y", "@scope/server", "/tmp"] });
  assert.deepEqual(splitServerCommand("  server-bin  "), { command: "server-bin", args: [] });
});

// ── happy path ─────────────────────────────────────────────────────────────────

test("with a server + goal, the command connects the transport and runs the loop", () => {
  const w = fakeWiring(okResult({ content: "the answer" }));
  const cap = capture();
  const cli = createMcpCli({ resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, createTransport: w.createTransport, createLoop: w.createLoop, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return cli.run(["--server", "npx -y server /tmp", "summarize the files"]).then(() => {
    assert.deepEqual(w.transports, [{ command: "npx", args: ["-y", "server", "/tmp"] }], "transport built from --server");
    assert.equal(w.requests.length, 1, "the loop ran once");
    assert.equal(w.requests[0]?.goal, "summarize the files");
    assert.match(cap.out, /mcp loop: completed \(2 round\(s\), stop: stop\)/);
    assert.match(cap.out, /the answer/);
    assert.equal(cap.exit, undefined, "a completed loop exits 0");
  });
});

test("a --model override is threaded into the loop request", () => {
  const w = fakeWiring(okResult());
  const cap = capture();
  const cli = createMcpCli({ resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, createTransport: w.createTransport, createLoop: w.createLoop, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return cli.run(["--server=srv", "--model=fast-1", "go"]).then(() => {
    assert.equal(w.requests[0]?.model, "fast-1");
  });
});

test("an incomplete loop exits non-zero", () => {
  const w = fakeWiring(okResult({ completed: false, stopReason: "max_iterations", reason: "did not converge" }));
  const cap = capture();
  const cli = createMcpCli({ resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, createTransport: w.createTransport, createLoop: w.createLoop, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return cli.run(["--server=srv", "go"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.out, /did not complete/);
  });
});

// ── fail-closed ──────────────────────────────────────────────────────────────

test("no --server ⇒ friendly error, nothing spawned", () => {
  const w = fakeWiring(okResult());
  const cap = capture();
  const cli = createMcpCli({ resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, createTransport: w.createTransport, createLoop: w.createLoop, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return cli.run(["just", "a", "goal"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /no MCP server.*--server/);
    assert.equal(w.transports.length, 0, "no transport built");
    assert.equal(w.requests.length, 0, "no loop run");
  });
});

test("an empty goal ⇒ usage hint, no loop", () => {
  const w = fakeWiring(okResult());
  const cap = capture();
  const cli = createMcpCli({ resolveIdentity: operatorResolver(), operatorToken: OPERATOR_TOKEN, createTransport: w.createTransport, createLoop: w.createLoop, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return cli.run(["--server", "srv"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /nothing to do/);
    assert.equal(w.requests.length, 0);
  });
});

test("no operator token ⇒ friendly error before connecting", () => {
  const w = fakeWiring(okResult());
  const cap = capture();
  const cli = createMcpCli({ resolveIdentity: operatorResolver(), operatorToken: undefined, createTransport: w.createTransport, createLoop: w.createLoop, stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1 });
  return cli.run(["--server", "srv", "go"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /no operator identity.*IKBI_OPERATOR_TOKEN/);
    assert.equal(w.transports.length, 0, "no transport built without identity");
  });
});

test("a loop that throws is reported cleanly (no raw stack), exit 1", () => {
  const cap = capture();
  const transport = { connect: async () => {}, listTools: async () => [], callTool: async () => "", close: async () => {} } satisfies McpTransport;
  const cli = createMcpCli({
    resolveIdentity: operatorResolver(),
    operatorToken: OPERATOR_TOKEN,
    createTransport: () => transport,
    createLoop: () => ({ run: async () => { throw new Error("server handshake failed"); } }),
    stdout: cap.stdout, stderr: cap.stderr, setExit: cap.setExit, now: () => 1,
  });
  return cli.run(["--server", "srv", "go"]).then(() => {
    assert.equal(cap.exit, 1);
    assert.match(cap.err, /loop failed: server handshake failed/);
    assert.ok(!cap.err.includes("\n    at "), "no raw stack frames leaked");
  });
});
