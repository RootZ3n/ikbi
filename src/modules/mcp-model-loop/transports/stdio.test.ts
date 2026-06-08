import assert from "node:assert/strict";
import { execPath } from "node:process";
import { test } from "node:test";

import { createStdioTransport, type SpawnedChild, type SpawnLike } from "./stdio.js";

// ── deterministic fake MCP server (injected spawn) ───────────────────────────

interface FakeOpts {
  /** Emit each response split across two stdout chunks (exercises newline buffering). */
  readonly split?: boolean;
}

/** A fake stdio MCP server: parses JSON-RPC lines written to stdin, answers on stdout. */
function fakeMcp(opts: FakeOpts = {}): { spawn: SpawnLike; writes: string[] } {
  const writes: string[] = [];
  const spawn: SpawnLike = () => {
    let dataCb: ((chunk: Buffer | string) => void) | undefined;
    const emit = (obj: unknown): void => {
      const line = `${JSON.stringify(obj)}\n`;
      setImmediate(() => {
        if (opts.split && line.length > 4) {
          const mid = Math.floor(line.length / 2);
          dataCb?.(line.slice(0, mid));
          dataCb?.(line.slice(mid));
        } else {
          dataCb?.(line);
        }
      });
    };
    const child: SpawnedChild = {
      stdin: {
        write(data: string): unknown {
          writes.push(data);
          for (const raw of data.split("\n")) {
            const t = raw.trim();
            if (t.length === 0) continue;
            const m = JSON.parse(t) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
            if (m.id === undefined) continue; // notification
            if (m.method === "initialize") emit({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } } });
            else if (m.method === "tools/list") emit({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
            else if (m.method === "tools/call" && m.params?.name === "echo") emit({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `echo:${String(m.params?.arguments?.text ?? "")}` }] } });
            else if (m.method === "tools/call") emit({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool: ${String(m.params?.name)}` } });
            else emit({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
          }
          return true;
        },
      },
      stdout: { on(_event, cb) { dataCb = cb; } },
      stderr: { on() { /* noop */ } },
      on() { /* exit/error not exercised here */ },
      kill() { /* noop */ },
    };
    return child;
  };
  return { spawn, writes };
}

test("stdio: connect handshakes, then lists and calls a tool over JSON-RPC", async () => {
  const fake = fakeMcp();
  const t = createStdioTransport({ command: "fake-mcp", spawnImpl: fake.spawn });
  await t.connect();

  // The handshake sent an initialize request and an initialized notification.
  assert.ok(fake.writes.some((w) => w.includes('"method":"initialize"')));
  assert.ok(fake.writes.some((w) => w.includes('"method":"notifications/initialized"')));

  const tools = await t.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "echo");
  assert.deepEqual(tools[0]?.parameters, { type: "object", properties: { text: { type: "string" } }, required: ["text"] });

  const out = await t.callTool("echo", JSON.stringify({ text: "hello mcp" }));
  assert.equal(out, "echo:hello mcp");

  await t.close();
});

test("stdio: handles responses split across stdout chunks (newline buffering)", async () => {
  const fake = fakeMcp({ split: true });
  const t = createStdioTransport({ command: "fake-mcp", spawnImpl: fake.spawn });
  await t.connect();
  const out = await t.callTool("echo", JSON.stringify({ text: "chunked" }));
  assert.equal(out, "echo:chunked");
  await t.close();
});

test("stdio: a JSON-RPC error response rejects the call", async () => {
  const fake = fakeMcp();
  const t = createStdioTransport({ command: "fake-mcp", spawnImpl: fake.spawn });
  await t.connect();
  await assert.rejects(() => t.callTool("nonexistent", "{}"), /MCP error -32602: unknown tool: nonexistent/);
  await t.close();
});

test("stdio: a request before connect is rejected (not connected)", async () => {
  const fake = fakeMcp();
  const t = createStdioTransport({ command: "fake-mcp", spawnImpl: fake.spawn });
  await assert.rejects(() => t.listTools(), /not connected/);
});

test("stdio: a per-request timeout fires when the server never answers", async () => {
  // A spawn whose child never emits anything → initialize times out fast.
  const silent: SpawnLike = () => ({
    stdin: { write: () => true },
    stdout: { on() { /* never emits */ } },
    stderr: { on() {} },
    on() {},
    kill() {},
  });
  const t = createStdioTransport({ command: "silent", spawnImpl: silent, timeoutMs: 80 });
  await assert.rejects(() => t.connect(), /timed out/);
});

// ── real subprocess integration (proves end-to-end stdio framing) ────────────

const REAL_MCP_SERVER = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result;
    if (m.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "real-test" } };
    else if (m.method === "tools/list") result = { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }] };
    else if (m.method === "tools/call") result = { content: [{ type: "text", text: "pong:" + ((m.params && m.params.arguments && m.params.arguments.msg) || "") }] };
    else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } }) + "\\n"); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

test("stdio (real subprocess): connect + listTools + callTool against a node MCP server", async () => {
  const t = createStdioTransport({ command: execPath, args: ["-e", REAL_MCP_SERVER], timeoutMs: 8_000 });
  try {
    await t.connect();
    const tools = await t.listTools();
    assert.equal(tools[0]?.name, "ping");
    const out = await t.callTool("ping", JSON.stringify({ msg: "from-ikbi" }));
    assert.equal(out, "pong:from-ikbi");
  } finally {
    await t.close();
  }
});
