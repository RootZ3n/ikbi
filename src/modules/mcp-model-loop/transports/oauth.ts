/**
 * ikbi MCP transport — OAuth 2.0 for REMOTE MCP servers.
 *
 * A remote (HTTP) MCP server typically sits behind OAuth. This module is the auth half of that: it
 * obtains, stores, and refreshes tokens so an HTTP transport can attach a bearer token. It does NOT
 * touch the stdio transport (local servers need no auth) — stdio keeps working unchanged.
 *
 * It implements the OAuth 2.0 DEVICE AUTHORIZATION GRANT (RFC 8628) — the simplest, most robust
 * flow for a CLI: ikbi asks the server for a user code + verification URL, the operator approves in
 * a browser, and ikbi polls for the token. It also exposes PKCE helpers (RFC 7636) for an
 * authorization-code variant, and automatic refresh-token rotation (RFC 6749 §6).
 *
 * SECURITY:
 *   - All HTTP goes through the egress guard (`resolveFetchGuard`) — the contract forbids an
 *     unguarded network transport. Tests inject a fetch double.
 *   - Tokens are written via `atomicWriteJson` with mode 0600 (owner-only) under
 *     `<stateRoot>/mcp-oauth/<server>.json` — never word-readable, never a torn write.
 *   - A refresh is attempted automatically when the access token is within the expiry skew; a
 *     failed refresh clears the stored token (fail-closed) rather than serving a stale credential.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { config } from "../../../core/config.js";
import type { FetchLike } from "../../../core/provider/providers/openai-compatible.js";
import { resolveFetchGuard } from "../../../core/provider/fetch-guard.js";
import { atomicWriteJson } from "../../../core/substrate/atomic.js";

/** OAuth endpoints + client identity for one remote MCP server. */
export interface OAuthServerConfig {
  /** Server label — matches the MCP server name; keys the stored token. */
  readonly name: string;
  /** The OAuth client id registered with the server. */
  readonly clientId: string;
  /** Device Authorization endpoint (RFC 8628) — where the device-code flow begins. */
  readonly deviceAuthorizationEndpoint: string;
  /** Token endpoint — exchanges the device code (and later the refresh token) for access tokens. */
  readonly tokenEndpoint: string;
  /** Optional client secret (public clients omit it; PKCE/device flows usually do). */
  readonly clientSecret?: string;
  /** Requested scopes (space-joined in the request). */
  readonly scopes?: readonly string[];
}

/** A persisted token set for one server. */
export interface StoredToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Token type, normally "Bearer". */
  readonly tokenType: string;
  /** Absolute epoch-ms expiry. Absent ⇒ no known expiry (never auto-refreshed). */
  readonly expiresAt?: number;
  readonly scope?: string;
  /** When the token was obtained (epoch ms). */
  readonly obtainedAt: number;
}

/** The device-authorization response (RFC 8628 §3.2). */
export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Pre-filled verification URL (`verification_uri_complete`), when the server provides one. */
  readonly verificationUriComplete?: string;
  /** Seconds until the device code expires. */
  readonly expiresIn: number;
  /** Minimum seconds between token polls. */
  readonly interval: number;
}

/** Injectable surfaces (HTTP, clock, sleep, token store) — all default to live implementations. */
export interface OAuthDeps {
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly store?: TokenStore;
}

/** Persisted-token store (atomic, owner-only). The dir is injectable for tests. */
export class TokenStore {
  constructor(private readonly dir: string = join(config.stateRoot, "mcp-oauth")) {}

  private file(server: string): string {
    // Sanitize the server name into a safe filename (no path separators).
    const safe = server.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  get(server: string): StoredToken | undefined {
    const f = this.file(server);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as StoredToken;
    } catch {
      return undefined;
    }
  }

  async put(server: string, token: StoredToken): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mode 0600 — owner read/write only (tokens are secrets). atomicWriteJson stringifies the value.
    await atomicWriteJson(this.file(server), token, { mode: 0o600 });
  }

  delete(server: string): void {
    const f = this.file(server);
    try {
      if (existsSync(f)) rmSync(f);
    } catch {
      /* best-effort */
    }
  }

  has(server: string): boolean {
    return existsSync(this.file(server));
  }
}

/** Refresh this many ms BEFORE the real expiry (clock skew + request latency cushion). */
const EXPIRY_SKEW_MS = 60_000;

/** A typed OAuth failure. */
export class OAuthError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "OAuthError";
  }
}

// ── PKCE (RFC 7636) ──────────────────────────────────────────────────────────────

/** A PKCE verifier/challenge pair for an authorization-code flow. */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

/** base64url encode (no padding) — the PKCE + URL-safe encoding. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE code_verifier + S256 code_challenge (RFC 7636 §4). */
export function generatePkce(randomImpl: (n: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64url(randomImpl(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────────

/** URL-encode a flat string map as an application/x-www-form-urlencoded body. */
function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** POST a form body to an OAuth endpoint and parse the JSON response. */
async function postForm(fetchImpl: FetchLike, url: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: formEncode(params),
    signal: controller.signal,
    redirect: "error",
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed = await res.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    /* non-JSON error body — leave body empty */
  }
  return { ok: res.ok, status: res.status, body };
}

/** Build a StoredToken from a token-endpoint response body. */
function toStoredToken(body: Record<string, unknown>, now: number, fallbackRefresh?: string): StoredToken {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (accessToken.length === 0) throw new OAuthError("token response missing access_token");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefresh;
  return {
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    ...(expiresIn !== undefined ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    obtainedAt: now,
  };
}

// ── Device authorization grant (RFC 8628) ──────────────────────────────────────────

/** Begin the device-authorization flow: request a device + user code from the server. */
export async function startDeviceAuthorization(cfg: OAuthServerConfig, deps: OAuthDeps = {}): Promise<DeviceAuthorization> {
  const fetchImpl = deps.fetch ?? resolveFetchGuard();
  const params: Record<string, string> = { client_id: cfg.clientId };
  if (cfg.scopes !== undefined && cfg.scopes.length > 0) params.scope = cfg.scopes.join(" ");
  const { ok, status, body } = await postForm(fetchImpl, cfg.deviceAuthorizationEndpoint, params);
  if (!ok) {
    throw new OAuthError(`device authorization failed (HTTP ${status})${typeof body.error === "string" ? `: ${body.error}` : ""}`, typeof body.error === "string" ? body.error : undefined);
  }
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const userCode = typeof body.user_code === "string" ? body.user_code : "";
  const verificationUri = typeof body.verification_uri === "string" ? body.verification_uri : (typeof body.verification_url === "string" ? body.verification_url : "");
  if (deviceCode.length === 0 || userCode.length === 0 || verificationUri.length === 0) {
    throw new OAuthError("device authorization response missing device_code / user_code / verification_uri");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof body.verification_uri_complete === "string" ? { verificationUriComplete: body.verification_uri_complete } : {}),
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
    interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
  };
}

/** Poll the token endpoint until the user approves (or the device code expires / is denied). */
export async function pollDeviceToken(cfg: OAuthServerConfig, auth: DeviceAuthorization, deps: OAuthDeps = {}): Promise<StoredToken> {
  const fetchImpl = deps.fetch ?? resolveFetchGuard();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + auth.expiresIn * 1000;
  let intervalMs = auth.interval * 1000;
  for (;;) {
    if (now() >= deadline) throw new OAuthError("device code expired before authorization", "expired_token");
    await sleep(intervalMs);
    const params: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: auth.deviceCode,
      client_id: cfg.clientId,
    };
    if (cfg.clientSecret !== undefined) params.client_secret = cfg.clientSecret;
    const { ok, body } = await postForm(fetchImpl, cfg.tokenEndpoint, params);
    if (ok) return toStoredToken(body, now());
    const error = typeof body.error === "string" ? body.error : "unknown_error";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5_000; // RFC 8628 §3.5: back off by 5s on slow_down
      continue;
    }
    // access_denied, expired_token, or anything else → terminal.
    throw new OAuthError(`device token poll failed: ${error}`, error);
  }
}

/**
 * Run the FULL device-code flow: start authorization, prompt the operator (via `onPrompt`), poll,
 * and PERSIST the resulting token. Returns the stored token.
 */
export async function deviceCodeFlow(
  cfg: OAuthServerConfig,
  onPrompt: (auth: DeviceAuthorization) => void,
  deps: OAuthDeps = {},
): Promise<StoredToken> {
  const store = deps.store ?? new TokenStore();
  const auth = await startDeviceAuthorization(cfg, deps);
  onPrompt(auth);
  const token = await pollDeviceToken(cfg, auth, deps);
  await store.put(cfg.name, token);
  return token;
}

// ── Refresh + access-token retrieval ───────────────────────────────────────────────

/** Exchange a refresh token for a fresh access token (RFC 6749 §6). Does NOT persist. */
export async function refreshAccessToken(cfg: OAuthServerConfig, stored: StoredToken, deps: OAuthDeps = {}): Promise<StoredToken> {
  if (stored.refreshToken === undefined) throw new OAuthError("no refresh_token available", "no_refresh_token");
  const fetchImpl = deps.fetch ?? resolveFetchGuard();
  const now = deps.now ?? Date.now;
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: cfg.clientId,
  };
  if (cfg.clientSecret !== undefined) params.client_secret = cfg.clientSecret;
  if (cfg.scopes !== undefined && cfg.scopes.length > 0) params.scope = cfg.scopes.join(" ");
  const { ok, status, body } = await postForm(fetchImpl, cfg.tokenEndpoint, params);
  if (!ok) {
    throw new OAuthError(`token refresh failed (HTTP ${status})${typeof body.error === "string" ? `: ${body.error}` : ""}`, typeof body.error === "string" ? body.error : undefined);
  }
  // The server MAY omit a new refresh_token (then we keep the old one — RFC 6749 §6).
  return toStoredToken(body, now(), stored.refreshToken);
}

/** True when a token is missing an expiry-safe window (needs refresh before use). */
export function isExpired(token: StoredToken, now: number): boolean {
  return token.expiresAt !== undefined && now >= token.expiresAt - EXPIRY_SKEW_MS;
}

/**
 * Return a VALID access token for a server, refreshing automatically when the stored one is within
 * the expiry skew. Returns undefined when no token is stored or a refresh fails (fail-closed: a
 * failed refresh clears the stored token rather than serving a stale credential).
 */
export async function getValidAccessToken(cfg: OAuthServerConfig, deps: OAuthDeps = {}): Promise<string | undefined> {
  const store = deps.store ?? new TokenStore();
  const now = deps.now ?? Date.now;
  const stored = store.get(cfg.name);
  if (stored === undefined) return undefined;
  if (!isExpired(stored, now())) return stored.accessToken;
  if (stored.refreshToken === undefined) {
    // Expired and unrefreshable — drop it so the caller re-authorizes.
    store.delete(cfg.name);
    return undefined;
  }
  try {
    const refreshed = await refreshAccessToken(cfg, stored, deps);
    await store.put(cfg.name, refreshed);
    return refreshed.accessToken;
  } catch {
    store.delete(cfg.name);
    return undefined;
  }
}

/**
 * Build the Authorization header for a server's current token (refreshing as needed). Returns an
 * empty object when there is no usable token — an HTTP transport simply sends no auth header then.
 */
export async function authorizationHeader(cfg: OAuthServerConfig, deps: OAuthDeps = {}): Promise<Record<string, string>> {
  const token = await getValidAccessToken(cfg, deps);
  if (token === undefined) return {};
  const stored = (deps.store ?? new TokenStore()).get(cfg.name);
  const type = stored?.tokenType ?? "Bearer";
  return { Authorization: `${type} ${token}` };
}
