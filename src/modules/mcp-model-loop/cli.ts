/**
 * ikbi mcp-model-loop — the `ikbi mcp` CLI command (opt-in stdio transport).
 *
 * Closes the audit gap: the stdio transport was real but had NO operator entrypoint —
 * the default loop ran the in-process MOCK. This command wires the REAL stdio transport
 * for an operator: it spawns an MCP server as a child process, runs ikbi's governed
 * model+tool loop against the server's advertised tools toward a goal, and reports the
 * outcome.
 *
 *   ikbi mcp --server "<command [args...]>" <goal...>
 *
 * e.g.  ikbi mcp --server "npx -y @modelcontextprotocol/server-filesystem /tmp" \
 *                "list the files under /tmp and summarize them"
 *
 * The --server value is the operator-configured server command (split on whitespace
 * into executable + args). It is the operator's deliberate, audited choice — like adding
 * a binary to the governed-exec allowlist; the model can only call tools the connected
 * server advertised, and EVERY call is gate-walled + every result neutralized by the loop.
 *
 * Fail-closed + friendly: a missing operator token, a missing --server, or an empty goal
 * prints a clear message and exits non-zero BEFORE anything spawns; a loop failure is
 * reported cleanly (never a raw stack).
 */

import { registerCommand } from "../../cli/registry.js";
import { config } from "../../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, ValidatedIdentity } from "../../core/identity/index.js";
import type { McpModelLoop, McpTransport } from "./contract.js";
import { createMcpModelLoop } from "./loop.js";
import { createStdioTransport } from "./transports/stdio.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parse `--server <command>` / `--server=<command>` and `--model <id>`; the rest is the goal. */
export function parseMcpArgs(argv: readonly string[]): { server?: string; model?: string; rest: string[] } {
  const rest: string[] = [];
  let server: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--server") {
      server = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--server=")) {
      server = a.slice("--server=".length);
    } else if (a === "--model") {
      model = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else {
      rest.push(a);
    }
  }
  return {
    ...(server !== undefined && server.length > 0 ? { server } : {}),
    ...(model !== undefined && model.length > 0 ? { model } : {}),
    rest,
  };
}

/** Split a server command string into its executable + args (whitespace-delimited). */
export function splitServerCommand(server: string): { command: string; args: string[] } {
  const parts = server.trim().split(/\s+/).filter((p) => p.length > 0);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

/** Injectable surfaces so the command is testable without a real child process / model. */
export interface McpCliDeps {
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  /** Build the transport from the parsed server command. Default: real stdio transport. */
  readonly createTransport?: (opts: { command: string; args: string[] }) => McpTransport;
  /** Build the loop around a transport. Default: the live loop (real provider + gate-wall). */
  readonly createLoop?: (transport: McpTransport) => McpModelLoop;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
}

/** Build the `ikbi mcp` handler. Defaults wire the live identity + stdio transport + loop. */
export function createMcpCli(deps: McpCliDeps = {}) {
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const createTransport = deps.createTransport ?? ((opts) => createStdioTransport(opts));
  const createLoop = deps.createLoop ?? ((transport) => createMcpModelLoop({ transport }));
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const now = deps.now ?? Date.now;

  async function run(argv: readonly string[]): Promise<void> {
    const { server, model, rest } = parseMcpArgs(argv);
    const goal = rest.join(" ").trim();

    if (server === undefined) {
      err('ikbi mcp: no MCP server — pass --server "<command [args...]>" (the stdio MCP server to connect to)\n');
      setExit(1);
      return;
    }
    const { command, args } = splitServerCommand(server);
    if (command.length === 0) {
      err("ikbi mcp: --server is empty — give a server executable\n");
      setExit(1);
      return;
    }
    if (goal.length === 0) {
      err('ikbi mcp: nothing to do — usage: ikbi mcp --server "<command>" <goal...>\n');
      setExit(1);
      return;
    }
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi mcp: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return;
    }
    let who: ValidatedIdentity;
    try {
      who = resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi mcp: operator identity resolution failed: ${errMsg(e)} — check IKBI_OPERATOR_TOKEN / the agents registry\n`);
      setExit(1);
      return;
    }

    const ctx = beginOperation(who, { requestId: `mcp-${now()}` });
    const transport = createTransport({ command, args });
    const loop = createLoop(transport);
    out(`ikbi mcp: connecting to "${command}${args.length > 0 ? ` ${args.join(" ")}` : ""}" …\n`);
    try {
      const result = await loop.run({ parentCtx: ctx, goal, ...(model !== undefined ? { model } : {}) });
      out(
        [
          `mcp loop: ${result.completed ? "completed" : "did not complete"} (${result.rounds} round(s), stop: ${result.stopReason})`,
          `tool calls gated: ${result.gatedCalls} (denied ${result.deniedCalls}); results neutralized: ${result.neutralizedCount}`,
          ...(result.content !== undefined && result.content.length > 0 ? ["", result.content] : []),
          ...(result.reason !== undefined ? [`reason: ${result.reason}`] : []),
          "",
        ].join("\n"),
      );
      if (!result.completed) setExit(1);
    } catch (e) {
      err(`ikbi mcp: loop failed: ${errMsg(e)}\n`);
      setExit(1);
    }
  }

  return { run };
}

// Register the LIVE command at import time (the modules barrel imports mcp-model-loop,
// whose index side-effect-imports this file).
const liveMcp = createMcpCli();
registerCommand({
  name: "mcp",
  summary: "Run the governed MCP model+tool loop against a stdio MCP server",
  usage: 'ikbi mcp --server "<command [args...]>" <goal...> [--model <id>]',
  run: (argv) => liveMcp.run(argv),
});
