/**
 * ikbi mcp-model-loop — the MCP TOOL REGISTRY that exposes operator-configured MCP
 * servers' tools to the REPL and the builder.
 *
 * The `mcp-model-loop` (loop.ts) drives its OWN standalone model+tool loop. This
 * registry is the OTHER integration: it lets the REPL/builder — which run their own
 * loops — augment their built-in tool set with MCP-discovered tools, WITHOUT coupling
 * to the loop's internals. It connects to each configured stdio server, discovers its
 * tools, and exposes a governed `dispatch` the host loop routes MCP calls through.
 *
 * It mirrors the loop's two OUTBOUND invariants exactly (it consumes the same gate-wall
 * and stdio transport — no MCP-internal change):
 *   1. SESSION GATE — `gateWall.evaluate` an `mcp.connect` exec action per server BEFORE
 *      the transport is connected. A deny skips that server (no connect, no discovery).
 *   2. PER-CALL GATE — every `dispatch` `gateWall.evaluate`s the tool call (exec action)
 *      BEFORE the transport is touched; a deny returns an ERROR string and NEVER invokes
 *      the transport.
 *
 * The INBOUND invariant (neutralize every result) stays with the HOST's existing
 * chokepoint: `dispatch` returns the RAW result string (still UNTRUSTED), and the
 * builder/chat feed it back through their own `appendToolResult` (neutralizeUntrusted +
 * toUntrustedMessage, source "mcp_result"). This registry only produces; it never
 * neutralizes — same discipline as the shared tool-executor.
 *
 * GRACEFUL DEGRADATION: a server that fails to connect / list tools is logged and
 * skipped. Discovery never throws and never blocks the REPL/builder — when no servers
 * are configured (the default) it returns an empty registry with zero overhead.
 */

import { childLogger } from "../../core/log.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import type { ModelTool, ToolCall } from "../../core/provider/contract.js";
import { asTier, autonomyForTier, TRUST_FLOOR } from "../../core/trust/index.js";
import { gateWall as coreGateWall, type GateWall } from "../gate-wall/index.js";
import { mcpServers, type McpServerConfig } from "./config.js";
import { createStdioTransport } from "./transports/stdio.js";
import type { McpToolDef, McpTransport } from "./contract.js";

const log = childLogger("mcp-registry");

/** Namespacing prefix so an MCP tool can NEVER collide with a built-in tool name. */
const MCP_PREFIX = "mcp__";

/** True for an exposed tool name that targets an MCP server (the namespaced form). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

/** Sanitize a server/tool name into the `[A-Za-z0-9_]` charset every provider accepts. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

/** A non-secret summary of a call's args for the GATE action (never the raw args). */
function summarizeArgs(argsJson: string): string {
  return `args(${argsJson.length} chars)`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The autonomy grant for an identity's trust tier — same derivation the loop uses. */
function grantFor(identity: AgentIdentity): ReturnType<typeof autonomyForTier> {
  return autonomyForTier(asTier(identity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
}

/** One discovered MCP tool: its exposed (namespaced) name maps to its server + raw name. */
interface McpEntry {
  readonly transport: McpTransport;
  readonly originalName: string;
  readonly serverName: string;
}

/**
 * The set of MCP tools discovered from the configured servers, plus the governed
 * dispatch the host loop routes MCP calls through and the teardown for the transports.
 */
export interface McpToolRegistry {
  /** The discovered tools as provider `ModelTool[]` (namespaced) to advertise to the model. */
  readonly tools: readonly ModelTool[];
  /** True when `name` is a discovered MCP tool this registry can dispatch. */
  has(name: string): boolean;
  /**
   * GOVERNED dispatch: gate-wall the call, then invoke the transport. Returns the RAW
   * result string (UNTRUSTED — the caller MUST neutralize it at its own chokepoint). A
   * gate denial / unknown tool / transport failure returns an `ERROR:`/`DENIED` string.
   */
  dispatch(call: ToolCall, identity: AgentIdentity): Promise<string>;
  /** Tear down every connected transport (kills the spawned child processes). Best-effort. */
  close(): Promise<void>;
}

/** The empty registry — what an unconfigured (or fully-failed) discovery returns. */
const EMPTY_REGISTRY: McpToolRegistry = Object.freeze({
  tools: Object.freeze([]) as readonly ModelTool[],
  has: () => false,
  dispatch: async (call: ToolCall) => `ERROR: MCP tool "${call.name}" is not registered (no MCP servers configured)`,
  close: async () => {},
});

/** Injectable dependencies for `discoverMcpTools` (tests substitute servers / gateWall / transport). */
export interface DiscoverMcpToolsOptions {
  /** The identity the MCP session + calls are gated on behalf of (must carry a trust tier). */
  readonly identity: AgentIdentity;
  /** Servers to connect to. Default: the process-wide `mcpServers` (from `IKBI_MCP_SERVERS`). */
  readonly servers?: readonly McpServerConfig[];
  /** Outbound governance. Default: the live gate-wall. */
  readonly gateWall?: GateWall;
  /** Transport factory (tests inject a mock). Default: a real stdio transport per server. */
  readonly transportFactory?: (server: McpServerConfig) => McpTransport;
}

/**
 * Connect to every configured MCP server, discover its tools, and build a governed
 * `McpToolRegistry`. NEVER throws and NEVER blocks: a server that fails the session
 * gate or the connect/list handshake is logged and skipped. Returns the empty registry
 * when nothing is configured or every server failed.
 */
export async function discoverMcpTools(opts: DiscoverMcpToolsOptions): Promise<McpToolRegistry> {
  const servers = opts.servers ?? mcpServers;
  if (servers.length === 0) return EMPTY_REGISTRY;

  const gateWall = opts.gateWall ?? coreGateWall;
  const sessionGrant = grantFor(opts.identity);

  const entries = new Map<string, McpEntry>();
  const tools: ModelTool[] = [];
  const transports: McpTransport[] = [];

  for (const server of servers) {
    let transport: McpTransport | undefined;
    try {
      // (1) SESSION GATE — authorize talking to this server BEFORE connecting. connect()
      // reaches an external process and listTools() ingests UNTRUSTED tool defs from it;
      // both are outbound. A deny ⇒ no connect, no discovery for this server.
      const sessionGov = await gateWall.evaluate({
        grant: sessionGrant,
        action: { kind: "exec", command: "mcp.connect", args: [server.name], sudo: false, purpose: "mcp session" },
        identity: opts.identity,
      });
      if (!sessionGov.allow) {
        log.warn({ server: server.name, reason: sessionGov.reason ?? "not permitted" }, "mcp: session gate denied — skipping server");
        continue;
      }

      transport =
        opts.transportFactory !== undefined
          ? opts.transportFactory(server)
          : createStdioTransport({ command: server.command, args: server.args, ...(server.cwd !== undefined ? { cwd: server.cwd } : {}) });
      await transport.connect();
      const defs: readonly McpToolDef[] = await transport.listTools();
      transports.push(transport);

      let added = 0;
      for (const def of defs) {
        const exposed = `${MCP_PREFIX}${sanitize(server.name)}__${sanitize(def.name)}`;
        if (entries.has(exposed)) {
          log.warn({ tool: exposed, server: server.name }, "mcp: duplicate exposed tool name — skipping");
          continue;
        }
        entries.set(exposed, { transport, originalName: def.name, serverName: server.name });
        tools.push({ name: exposed, description: `[MCP:${server.name}] ${def.description}`, parameters: def.parameters });
        added += 1;
      }
      log.info({ server: server.name, tools: added }, "mcp: connected and discovered tools");
    } catch (e) {
      // GRACEFUL DEGRADATION: a connection/handshake failure is a WARNING, never an error —
      // the REPL/builder continue without this server's tools.
      log.warn({ server: server.name, err: errMsg(e) }, "mcp: connection failed — continuing without this server");
      if (transport !== undefined) {
        try {
          await transport.close();
        } catch {
          /* best-effort cleanup of a partially-connected transport */
        }
      }
    }
  }

  if (entries.size === 0) return EMPTY_REGISTRY;

  return {
    tools,
    has: (name) => entries.has(name),
    async dispatch(call, identity) {
      const entry = entries.get(call.name);
      if (entry === undefined) return `ERROR: MCP tool "${call.name}" is not registered`;
      // (2) PER-CALL GATE — evaluate BEFORE touching the transport. A deny never invokes it.
      const governance = await gateWall.evaluate({
        grant: grantFor(identity),
        action: { kind: "exec", command: entry.originalName, args: [summarizeArgs(call.arguments)], sudo: false, purpose: "mcp tool call" },
        identity,
      });
      if (!governance.allow) {
        return `ERROR: MCP tool "${call.name}" was DENIED by policy: ${governance.reason ?? "not permitted"}`;
      }
      try {
        return await entry.transport.callTool(entry.originalName, call.arguments);
      } catch (e) {
        return `ERROR: MCP tool "${call.name}" failed: ${errMsg(e)}`;
      }
    },
    async close() {
      for (const t of transports) {
        try {
          await t.close();
        } catch {
          /* best-effort — never throw on teardown */
        }
      }
    },
  };
}
