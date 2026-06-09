/**
 * ikbi mcp-model-loop — STDIO transport (real MCP over a child process).
 *
 * Implements `McpTransport` by spawning an MCP server as a child process and
 * speaking JSON-RPC 2.0 over its stdin/stdout, newline-delimited (the MCP stdio
 * framing: one JSON message per line, no embedded newlines). This lets ikbi connect
 * to ANY stdio MCP server (filesystem, git, fetch, custom). It is OPT-IN — the
 * in-process mock remains the default; an operator wires this via
 * `createMcpModelLoop({ transport: createStdioTransport({ command, args }) })`.
 *
 * SECURITY POSTURE (where this sits relative to the contract's three invariants):
 *  - This transport is pure I/O. The mcp-model-loop still owns the spine: it
 *    gate-walls the SESSION (mcp.connect) before connect() is called and gate-walls
 *    EVERY tool call before callTool(), and it neutralizes every result inbound.
 *  - stdio talks to a LOCAL child process — NO network — so the egress/SSRF floor
 *    (which the contract mandates for HTTP transports) does not apply here.
 *  - The server COMMAND is OPERATOR-configured (never model-controlled): the model
 *    can only invoke tools the connected server advertised, each gated. Spawning an
 *    arbitrary server is the operator's deliberate, audited choice — like adding a
 *    binary to the governed-exec allowlist.
 */

import { spawn as nodeSpawn } from "node:child_process";

import type { McpToolDef, McpTransport } from "../contract.js";

/** The minimal child-process surface this transport depends on (a subset of ChildProcess). */
export interface SpawnedChild {
  readonly stdin: { write(data: string): unknown };
  readonly stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void };
  readonly stderr?: { on(event: "data", cb: (chunk: Buffer | string) => void): void };
  on(event: "exit" | "close" | "error", cb: (...args: unknown[]) => void): void;
  kill(signal?: string): void;
}

/** Spawn function shape (injectable for tests). */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> },
) => SpawnedChild;

export interface StdioTransportOptions {
  /** The MCP server executable (operator-configured). */
  readonly command: string;
  /** Arguments for the server. */
  readonly args?: readonly string[];
  /** Working directory for the server process. */
  readonly cwd?: string;
  /** Extra environment for the server process (merged over the parent env). */
  readonly env?: Readonly<Record<string, string>>;
  /** Per-request timeout (ms). Default 30s. */
  readonly timeoutMs?: number;
  /** Injected spawn (tests). Default: node:child_process spawn with piped stdio. */
  readonly spawnImpl?: SpawnLike;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";
/** Bound the captured stderr used in diagnostics. */
const MAX_STDERR = 4_000;

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string };
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

const defaultSpawn: SpawnLike = (command, args, opts) =>
  nodeSpawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: opts.env !== undefined ? { ...process.env, ...opts.env } : process.env,
  }) as unknown as SpawnedChild;

/**
 * Build a stdio `McpTransport`. Construction does NOT spawn — `connect()` does (after
 * the loop has gate-walled the session), and `close()` tears the child down.
 */
export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: SpawnedChild | undefined;
  let closed = false;
  let nextId = 1;
  let buffer = "";
  let stderrTail = "";
  const pending = new Map<number, Pending>();

  const rejectAll = (reason: string): void => {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return; // ignore non-JSON noise on stdout
    }
    if (typeof msg.id !== "number") return; // a notification — no pending request
    const p = pending.get(msg.id);
    if (p === undefined) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) {
      p.reject(new Error(`MCP error ${msg.error.code ?? "?"}: ${msg.error.message ?? "unknown"}`));
    } else {
      p.resolve(msg.result);
    }
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  };

  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (child === undefined || closed) return Promise.reject(new Error("MCP stdio transport is not connected"));
    const id = nextId;
    nextId += 1;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms${stderrTail.length > 0 ? ` (stderr: ${stderrTail.slice(-200)})` : ""}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        child!.stdin.write(payload);
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`MCP stdin write failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  };

  const notify = (method: string, params: Record<string, unknown>): void => {
    if (child === undefined || closed) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      /* best-effort notification */
    }
  };

  return {
    async connect(): Promise<void> {
      if (child !== undefined) return; // idempotent
      const spawnOpts: { cwd?: string; env?: Record<string, string> } = {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: { ...options.env } } : {}),
      };
      child = spawnImpl(options.command, options.args ?? [], spawnOpts);
      child.stdout.on("data", onData);
      child.stderr?.on("data", (chunk) => {
        stderrTail = (stderrTail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(-MAX_STDERR);
      });
      child.on("exit", () => {
        closed = true;
        rejectAll(`MCP server process exited${stderrTail.length > 0 ? ` (stderr: ${stderrTail.slice(-200)})` : ""}`);
      });
      child.on("error", (err) => { closed = true; rejectAll(`MCP server process error: ${err instanceof Error ? err.message : String(err)}`); });

      // JSON-RPC handshake: initialize → initialized notification.
      await request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ikbi", version: "0.1.0" },
      });
      notify("notifications/initialized", {});
    },

    async listTools(): Promise<readonly McpToolDef[]> {
      const result = (await request("tools/list", {})) as { tools?: unknown };
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      return tools.map((t): McpToolDef => {
        const r = (t ?? {}) as Record<string, unknown>;
        const schema = r.inputSchema;
        return {
          name: String(r.name ?? ""),
          description: String(r.description ?? ""),
          parameters:
            typeof schema === "object" && schema !== null && !Array.isArray(schema)
              ? (schema as Record<string, unknown>)
              : { type: "object", properties: {} },
        };
      });
    },

    async callTool(name: string, argsJson: string): Promise<string> {
      let args: unknown = {};
      try {
        args = argsJson && argsJson.length > 0 ? JSON.parse(argsJson) : {};
      } catch {
        args = {};
      }
      const result = (await request("tools/call", { name, arguments: args })) as { content?: unknown };
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .filter((c): c is { type?: string; text?: unknown } => typeof c === "object" && c !== null)
        .filter((c) => c.type === "text")
        .map((c) => String(c.text ?? ""))
        .join("\n");
      return text.length > 0 ? text : JSON.stringify(result);
    },

    async close(): Promise<void> {
      closed = true;
      rejectAll("MCP stdio transport closed");
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      child = undefined;
    },
  };
}
