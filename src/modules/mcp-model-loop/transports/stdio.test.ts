import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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

// ── stream-backed integration (proves end-to-end stdio framing over real streams) ────────────

function streamBackedMcp(): SpawnLike {
  return () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    let buf = "";
    const send = (obj: unknown): void => {
      stdout.write(`${JSON.stringify(obj)}\n`);
    };
    stdin.on("data", (d) => {
      buf += d.toString("utf8");
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as { id?: number; method?: string; params?: { arguments?: { msg?: string } } };
        if (m.id === undefined) continue;
        let result: unknown;
        if (m.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stream-test" } };
        else if (m.method === "tools/list") result = { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }] };
        else if (m.method === "tools/call") result = { content: [{ type: "text", text: `pong:${m.params?.arguments?.msg ?? ""}` }] };
        else {
          send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
          continue;
        }
        send({ jsonrpc: "2.0", id: m.id, result });
      }
    });
    return {
      stdin,
      stdout,
      on: (event, cb) => void events.on(event, cb),
      kill: () => void events.emit("exit", 0),
    };
  };
}

test("stdio stream integration: connect + listTools + callTool over JSON-RPC framing", async () => {
  const t = createStdioTransport({ command: "stream-test", spawnImpl: streamBackedMcp(), timeoutMs: 8_000 });
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

// L3: malformed tool-arg JSON must NOT crash the call — it falls back to empty arguments
// (and logs a warning so the dropped payload is observable, not silent).
test("L3: callTool with malformed argument JSON falls back to empty arguments and still calls the tool", async () => {
  const fake = fakeMcp();
  const t = createStdioTransport({ command: "fake-mcp", spawnImpl: fake.spawn });
  try {
    await t.connect();
    // A truncated/garbled arg string (e.g. from a cheap model) — not valid JSON.
    const out = await t.callTool("echo", "{ text: 'oops not json");
    // The call proceeds with `{}`; the fake echoes the (absent) text as empty.
    assert.equal(out, "echo:", "the call proceeded with empty arguments rather than throwing");
    // The garbled payload was NOT forwarded as the tool arguments.
    const callWrite = fake.writes.find((w) => w.includes('"method":"tools/call"')) ?? "";
    assert.ok(callWrite.includes('"arguments":{}'), "arguments fell back to {} (the bad JSON was dropped)");
  } finally {
    await t.close();
  }
});

// ── C12: env scrub + bounded line buffer ───────────────────────────────────────
import { scrubSecretEnv } from "./stdio.js";

test("scrubSecretEnv strips secret-shaped vars, keeps functional ones (Codex C12)", () => {
  const scrubbed = scrubSecretEnv({
    PATH: "/usr/bin", HOME: "/home/x", LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp_x", MY_PASSWORD: "p", AWS_SECRET_ACCESS_KEY: "s", SESSION_TOKEN: "t",
  });
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.HOME, "/home/x");
  assert.equal(scrubbed.LANG, "en_US.UTF-8");
  for (const k of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "MY_PASSWORD", "AWS_SECRET_ACCESS_KEY", "SESSION_TOKEN"]) {
    assert.equal(scrubbed[k], undefined, `${k} must be scrubbed`);
  }
});

test("stdio: a newline-less stdout flood fails closed via the bounded buffer (Codex C12)", async () => {
  let dataCb: ((c: Buffer | string) => void) | undefined;
  let killed = false;
  const spawn: SpawnLike = () => ({
    stdin: { write() { return true; } },
    stdout: { on(_e: string, cb: (c: Buffer | string) => void) { dataCb = cb; } },
    stderr: { on() { /* noop */ } },
    on() { /* noop */ },
    kill() { killed = true; },
  } as unknown as SpawnedChild);
  const t = createStdioTransport({ command: "flooder", spawnImpl: spawn, timeoutMs: 2000 });
  const connectP = t.connect(); // awaits the initialize response, which never comes
  await new Promise((r) => setImmediate(r)); // let connect spawn + register the stdout handler
  dataCb?.("x".repeat(1_000_001)); // > MAX_LINE_BUFFER, no newline → fail closed
  await assert.rejects(connectP, /line buffer|closing/i);
  assert.equal(killed, true, "the misbehaving MCP child was killed");
});
