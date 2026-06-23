/**
 * ikbi mcp-model-loop — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("mcp-model-loop")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_MCP_MODEL_LOOP_`.
 *
 *   IKBI_MCP_MODEL_LOOP_ENABLED             on/off. DEFAULT ON. Disabled ⇒ the loop
 *                                           REFUSES (fail-closed — never a bypass).
 *   IKBI_MCP_MODEL_LOOP_MAX_TOOL_ITERATIONS hard cap on tool-call rounds.
 *   IKBI_MCP_MODEL_LOOP_TIMEOUT_MS          loop wall-clock budget.
 *
 * MCP SERVER ENDPOINTS — `IKBI_MCP_SERVERS`: a JSON array of stdio MCP servers the
 * REPL/builder connect to and discover tools from (see `loadMcpServers`). It is read
 * here (the module's config slice, NOT core `config.ts` — a module never adds a field
 * to `IkbiConfig`) by its EXACT name rather than through the auto-prefixing `moduleEnv`
 * reader, because the variable is `IKBI_MCP_SERVERS`, not `IKBI_MCP_MODEL_LOOP_SERVERS`.
 * DEFAULT: empty (no MCP servers — zero behavior change). Example:
 *   IKBI_MCP_SERVERS='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]'
 */

import { configEnv } from "../../core/config.js";
import { childLogger } from "../../core/log.js";
import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("mcp-model-loop");
const cfgLog = childLogger("mcp-config");

/** Logical roster model id the loop drives. */
export const LOOP_MODEL = "mimo-v2.5";
/** Sampling temperature for the loop. */
export const LOOP_TEMPERATURE = 0.1;
/** Max completion tokens per round. */
export const LOOP_MAX_TOKENS = 2048;
/** Hard cap on tool-call rounds — the loop can never run forever. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 20;
/** Loop wall-clock budget. */
export const DEFAULT_LOOP_TIMEOUT_MS = 120_000;

export interface McpModelLoopConfig {
  /** When false, the loop refuses fail-closed (NOT a bypass). */
  readonly enabled: boolean;
  /** Hard cap on tool-call rounds. */
  readonly maxToolIterations: number;
  /** Loop wall-clock budget (ms). */
  readonly loopTimeoutMs: number;
}

/** Load the mcp-model-loop config slice from `IKBI_MCP_MODEL_LOOP_*`. */
export function loadMcpModelLoopConfig(reader = env): McpModelLoopConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    maxToolIterations: reader.int("MAX_TOOL_ITERATIONS", DEFAULT_MAX_TOOL_ITERATIONS, { min: 1 }),
    loopTimeoutMs: reader.int("TIMEOUT_MS", DEFAULT_LOOP_TIMEOUT_MS, { min: 1 }),
  });
}

/** The process-wide mcp-model-loop config. */
export const mcpModelLoopConfig: McpModelLoopConfig = loadMcpModelLoopConfig();

/**
 * One operator-configured stdio MCP server. The `command` is OPERATOR-controlled
 * (never model-controlled) — like adding a binary to the governed-exec allowlist.
 */
export interface McpServerConfig {
  /** A short, unique label for the server (namespaces its tools: `mcp__<name>__<tool>`). */
  readonly name: string;
  /** The MCP server executable to spawn. */
  readonly command: string;
  /** Arguments for the server. */
  readonly args: readonly string[];
  /** Optional working directory for the server process. */
  readonly cwd?: string;
}

/**
 * Parse `IKBI_MCP_SERVERS` (a JSON array of `{name, command, args, cwd?}`) into the
 * configured server list. LENIENT BY DESIGN: a malformed value, a non-array, or an
 * entry missing `name`/`command` is logged and skipped — never a startup crash (a bad
 * MCP config must never block ikbi). Absent/blank ⇒ `[]` (no MCP servers).
 */
export function loadMcpServers(raw: string | undefined = configEnv.IKBI_MCP_SERVERS): readonly McpServerConfig[] {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    cfgLog.warn({ err: e instanceof Error ? e.message : String(e) }, "IKBI_MCP_SERVERS is not valid JSON — ignoring (no MCP servers)");
    return [];
  }
  if (!Array.isArray(parsed)) {
    cfgLog.warn("IKBI_MCP_SERVERS must be a JSON array of {name,command,args} — ignoring (no MCP servers)");
    return [];
  }
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const command = typeof o.command === "string" ? o.command.trim() : "";
    if (name.length === 0 || command.length === 0) {
      cfgLog.warn({ entry: o }, "IKBI_MCP_SERVERS entry missing name/command — skipping");
      continue;
    }
    if (seen.has(name)) {
      cfgLog.warn({ name }, "IKBI_MCP_SERVERS has a duplicate server name — skipping the later one");
      continue;
    }
    seen.add(name);
    const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [];
    const cwd = typeof o.cwd === "string" && o.cwd.trim().length > 0 ? o.cwd.trim() : undefined;
    servers.push(Object.freeze({ name, command, args: Object.freeze([...args]), ...(cwd !== undefined ? { cwd } : {}) }));
  }
  return Object.freeze(servers);
}

/** The process-wide configured MCP servers (parsed from `IKBI_MCP_SERVERS`). */
export const mcpServers: readonly McpServerConfig[] = loadMcpServers();

/**
 * OAuth endpoints for a REMOTE MCP server, keyed by the server `name`. OPERATOR-controlled (like the
 * server allowlist) — defines where `ikbi mcp auth <name>` runs the device-code flow. Parsed from
 * `IKBI_MCP_OAUTH`, a JSON array of `{name, clientId, deviceAuthorizationEndpoint, tokenEndpoint,
 * scopes?, clientSecret?}`. Absent/blank ⇒ `[]` (no OAuth servers).
 */
export interface McpOAuthConfig {
  readonly name: string;
  readonly clientId: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientSecret?: string;
  readonly scopes?: readonly string[];
}

/** Parse `IKBI_MCP_OAUTH` (JSON array) into per-server OAuth configs. Lenient: bad entries skipped. */
export function loadMcpOAuthConfigs(raw: string | undefined = configEnv.IKBI_MCP_OAUTH): readonly McpOAuthConfig[] {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    cfgLog.warn({ err: e instanceof Error ? e.message : String(e) }, "IKBI_MCP_OAUTH is not valid JSON — ignoring (no OAuth servers)");
    return [];
  }
  if (!Array.isArray(parsed)) {
    cfgLog.warn("IKBI_MCP_OAUTH must be a JSON array — ignoring (no OAuth servers)");
    return [];
  }
  const out: McpOAuthConfig[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const clientId = typeof o.clientId === "string" ? o.clientId.trim() : "";
    const deviceAuthorizationEndpoint = typeof o.deviceAuthorizationEndpoint === "string" ? o.deviceAuthorizationEndpoint.trim() : "";
    const tokenEndpoint = typeof o.tokenEndpoint === "string" ? o.tokenEndpoint.trim() : "";
    if (name.length === 0 || clientId.length === 0 || deviceAuthorizationEndpoint.length === 0 || tokenEndpoint.length === 0) {
      cfgLog.warn({ entry: o }, "IKBI_MCP_OAUTH entry missing name/clientId/deviceAuthorizationEndpoint/tokenEndpoint — skipping");
      continue;
    }
    if (seen.has(name)) {
      cfgLog.warn({ name }, "IKBI_MCP_OAUTH has a duplicate server name — skipping the later one");
      continue;
    }
    seen.add(name);
    const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === "string") : undefined;
    const clientSecret = typeof o.clientSecret === "string" && o.clientSecret.length > 0 ? o.clientSecret : undefined;
    out.push(Object.freeze({
      name,
      clientId,
      deviceAuthorizationEndpoint,
      tokenEndpoint,
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      ...(scopes !== undefined && scopes.length > 0 ? { scopes: Object.freeze([...scopes]) } : {}),
    }));
  }
  return Object.freeze(out);
}

/** The process-wide configured remote-MCP OAuth servers (parsed from `IKBI_MCP_OAUTH`). */
export const mcpOAuthConfigs: readonly McpOAuthConfig[] = loadMcpOAuthConfigs();
