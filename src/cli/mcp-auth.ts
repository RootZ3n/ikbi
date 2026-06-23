/**
 * ikbi `mcp auth <server>` — authorize ikbi against a REMOTE (OAuth) MCP server.
 *
 * Dispatched from the `ikbi mcp` command when its first argument is `auth` (so the stdio loop path
 * is untouched). It runs the OAuth 2.0 device-authorization flow: ikbi prints a user code + URL, the
 * operator approves in a browser, and ikbi polls for and stores the token (owner-only, auto-refreshed
 * on use).
 *
 *   ikbi mcp auth <server>          run the device-code flow for a configured OAuth server
 *   ikbi mcp auth list              list configured OAuth servers + which have a stored token
 *   ikbi mcp auth status <server>   show a server's stored-token status
 *   ikbi mcp auth logout <server>   delete a server's stored token
 *
 * Servers are configured via `IKBI_MCP_OAUTH` (see mcp-model-loop/config.ts).
 */

import { writeStdout, writeStderr } from "./io.js";
import { mcpOAuthConfigs, type McpOAuthConfig } from "../modules/mcp-model-loop/config.js";
import {
  deviceCodeFlow as liveDeviceCodeFlow,
  TokenStore,
  type DeviceAuthorization,
  type OAuthDeps,
  type OAuthServerConfig,
  type StoredToken,
} from "../modules/mcp-model-loop/transports/oauth.js";

export interface McpAuthDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  /** Configured OAuth servers (default: parsed from IKBI_MCP_OAUTH). */
  readonly configs?: readonly McpOAuthConfig[];
  /** Token store (default: the live owner-only store under <stateRoot>/mcp-oauth). */
  readonly store?: TokenStore;
  /** The device-code flow (default: the live one). Injectable for tests. */
  readonly deviceCodeFlow?: (cfg: OAuthServerConfig, onPrompt: (auth: DeviceAuthorization) => void, deps: OAuthDeps) => Promise<StoredToken>;
  readonly now?: () => number;
}

const SUBCOMMANDS = new Set(["list", "status", "logout", "--help", "-h"]);

export function createMcpAuthCli(deps: McpAuthDeps = {}) {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const configs = deps.configs ?? mcpOAuthConfigs;
  const store = deps.store ?? new TokenStore();
  const flow = deps.deviceCodeFlow ?? liveDeviceCodeFlow;
  const now = deps.now ?? Date.now;

  function findConfig(name: string): McpOAuthConfig | undefined {
    return configs.find((c) => c.name.toLowerCase() === name.toLowerCase());
  }

  async function run(argv: readonly string[]): Promise<void> {
    const first = argv[0];
    if (first === undefined || first === "--help" || first === "-h") {
      out("Usage: ikbi mcp auth <server> | list | status <server> | logout <server>\n");
      return;
    }

    if (first === "list") {
      if (configs.length === 0) {
        out("No OAuth MCP servers configured. Set IKBI_MCP_OAUTH (JSON array of {name, clientId, deviceAuthorizationEndpoint, tokenEndpoint}).\n");
        return;
      }
      out(`Configured OAuth MCP servers (${configs.length}):\n`);
      for (const c of configs) {
        out(`  • ${c.name} — ${store.has(c.name) ? "authorized (token stored)" : "not authorized"}\n`);
      }
      return;
    }

    if (first === "status") {
      const name = argv[1];
      if (name === undefined) { err("usage: ikbi mcp auth status <server>\n"); setExit(1); return; }
      const token = store.get(name);
      if (token === undefined) {
        out(`${name}: not authorized (no stored token)\n`);
        return;
      }
      const exp = token.expiresAt !== undefined ? (token.expiresAt <= now() ? "expired" : `expires in ${Math.round((token.expiresAt - now()) / 1000)}s`) : "no expiry";
      out(`${name}: authorized (${token.tokenType}, ${exp}${token.refreshToken !== undefined ? ", refreshable" : ""})\n`);
      return;
    }

    if (first === "logout") {
      const name = argv[1];
      if (name === undefined) { err("usage: ikbi mcp auth logout <server>\n"); setExit(1); return; }
      store.delete(name);
      out(`${name}: stored token cleared.\n`);
      return;
    }

    // Otherwise `first` is a server name to authorize.
    if (SUBCOMMANDS.has(first)) { err(`ikbi mcp auth: unknown subcommand "${first}"\n`); setExit(1); return; }
    const cfg = findConfig(first);
    if (cfg === undefined) {
      err(`ikbi mcp auth: no OAuth server "${first}" configured. Run 'ikbi mcp auth list' or set IKBI_MCP_OAUTH.\n`);
      setExit(1);
      return;
    }

    const serverCfg: OAuthServerConfig = {
      name: cfg.name,
      clientId: cfg.clientId,
      deviceAuthorizationEndpoint: cfg.deviceAuthorizationEndpoint,
      tokenEndpoint: cfg.tokenEndpoint,
      ...(cfg.clientSecret !== undefined ? { clientSecret: cfg.clientSecret } : {}),
      ...(cfg.scopes !== undefined ? { scopes: cfg.scopes } : {}),
    };

    const onPrompt = (auth: DeviceAuthorization): void => {
      out(`\nTo authorize "${cfg.name}", open:\n  ${auth.verificationUriComplete ?? auth.verificationUri}\n`);
      if (auth.verificationUriComplete === undefined) out(`and enter the code:  ${auth.userCode}\n`);
      out(`\nWaiting for approval (the code expires in ${Math.round(auth.expiresIn / 60)} min)…\n`);
    };

    try {
      const token = await flow(serverCfg, onPrompt, { store, now });
      out(`\n✅ Authorized "${cfg.name}" (${token.tokenType}${token.refreshToken !== undefined ? ", refresh token stored" : ""}). Token saved.\n`);
    } catch (e) {
      err(`\nikbi mcp auth: authorization failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  return { run };
}
