/**
 * ikbi configuration foundation.
 *
 * This is the ONE place env vars are read. Nothing else in the codebase
 * touches `process.env` directly — everything flows through `config`.
 *
 * All knobs are `IKBI_*` prefixed.
 */

import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

/** Resolved, validated, immutable runtime configuration. */
export interface IkbiConfig {
  /** Service version (from package.json). */
  readonly version: string;
  /** TCP port to bind. `IKBI_PORT`, default 18796. */
  readonly port: number;
  /** Host/interface to bind. `IKBI_BIND_HOST`, default 127.0.0.1. */
  readonly bindHost: string;
  /** Allow binding a non-loopback (public) interface. `IKBI_ALLOW_PUBLIC_BIND`, default false. */
  readonly allowPublicBind: boolean;
  /** Root directory for runtime state. `IKBI_STATE_ROOT`, default `<cwd>/state`. */
  readonly stateRoot: string;
  /** Log level. `IKBI_LOG_LEVEL`, default "info". */
  readonly logLevel: string;
  /** Runtime environment. `IKBI_ENV` (falls back to NODE_ENV), default "development". */
  readonly env: string;
  /** Model provider layer configuration. */
  readonly provider: ProviderConfig;
}

/** A provider HTTP endpoint (base URL + optional API key). */
export interface ProviderEndpointConfig {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

/** OpenRouter endpoint config (adds the attribution headers OpenRouter recommends). */
export interface OpenRouterEndpointConfig extends ProviderEndpointConfig {
  readonly referer: string | undefined;
  readonly title: string | undefined;
}

/** Circuit-breaker tuning for the provider layer. */
export interface CircuitConfig {
  /** Consecutive failures before the circuit opens. `IKBI_CIRCUIT_FAILURE_THRESHOLD`, default 5. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before a trial. `IKBI_CIRCUIT_COOLDOWN_MS`, default 30000. */
  readonly cooldownMs: number;
  /** Trial invocations allowed while half-open. `IKBI_CIRCUIT_HALF_OPEN_TRIALS`, default 1. */
  readonly halfOpenMaxTrials: number;
}

/** Configuration for the model provider layer. All `IKBI_*` env, read here only. */
export interface ProviderConfig {
  /** Per-request timeout. `IKBI_PROVIDER_TIMEOUT_MS`, default 60000. */
  readonly timeoutMs: number;
  /** Circuit-breaker tuning. */
  readonly circuit: CircuitConfig;
  /** Path to the JSON roster file (models + cost table + provider routes). `IKBI_PROVIDER_CONFIG`. */
  readonly rosterFile: string;
  /** mimo direct API endpoint. */
  readonly mimo: ProviderEndpointConfig;
  /** OpenRouter backup endpoint. */
  readonly openrouter: OpenRouterEndpointConfig;
  /** Default logical model ids for the standard roles (config-driven, not hardcoded downstream). */
  readonly defaultModels: { readonly driver: string; readonly critic: string };
}

const DEFAULT_PORT = 18796;
const DEFAULT_BIND_HOST = "127.0.0.1";

/** Loopback hosts that are always safe to bind without the public-bind flag. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean for env var: "${raw}" (expected true/false)`);
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid IKBI_PORT: "${raw}" (expected integer 1-65535)`);
  }
  return n;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${name}: "${raw}" (expected positive integer)`);
  }
  return n;
}

/** Optional trimmed string env var — undefined when absent or blank. */
function optStr(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v && v.length > 0 ? v : undefined;
}

function loadProviderConfig(env: NodeJS.ProcessEnv, stateRoot: string): ProviderConfig {
  const rosterRaw = optStr(env.IKBI_PROVIDER_CONFIG);
  const rosterFile = rosterRaw
    ? isAbsolute(rosterRaw)
      ? rosterRaw
      : resolve(process.cwd(), rosterRaw)
    : resolve(stateRoot, "providers.json");

  return {
    timeoutMs: parsePositiveInt("IKBI_PROVIDER_TIMEOUT_MS", env.IKBI_PROVIDER_TIMEOUT_MS, 60_000),
    circuit: {
      failureThreshold: parsePositiveInt(
        "IKBI_CIRCUIT_FAILURE_THRESHOLD",
        env.IKBI_CIRCUIT_FAILURE_THRESHOLD,
        5,
      ),
      cooldownMs: parsePositiveInt("IKBI_CIRCUIT_COOLDOWN_MS", env.IKBI_CIRCUIT_COOLDOWN_MS, 30_000),
      halfOpenMaxTrials: parsePositiveInt(
        "IKBI_CIRCUIT_HALF_OPEN_TRIALS",
        env.IKBI_CIRCUIT_HALF_OPEN_TRIALS,
        1,
      ),
    },
    rosterFile,
    mimo: {
      // NOTE: placeholder default — confirm mimo's real direct-API base URL and
      // override via IKBI_MIMO_BASE_URL. The provider speaks an OpenAI-compatible
      // /chat/completions shape; adjust the provider impl if mimo differs.
      baseUrl: optStr(env.IKBI_MIMO_BASE_URL) ?? "https://api.mimo.ai/v1",
      apiKey: optStr(env.IKBI_MIMO_API_KEY),
    },
    openrouter: {
      baseUrl: optStr(env.IKBI_OPENROUTER_BASE_URL) ?? "https://openrouter.ai/api/v1",
      apiKey: optStr(env.IKBI_OPENROUTER_API_KEY),
      referer: optStr(env.IKBI_OPENROUTER_REFERER),
      title: optStr(env.IKBI_OPENROUTER_TITLE),
    },
    defaultModels: {
      driver: optStr(env.IKBI_MODEL_DRIVER) ?? "mimo-v2.5",
      critic: optStr(env.IKBI_MODEL_CRITIC) ?? "mimo-v2.5-pro",
    },
  };
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): IkbiConfig {
  const port = parsePort(env.IKBI_PORT, DEFAULT_PORT);
  const bindHost = (env.IKBI_BIND_HOST ?? DEFAULT_BIND_HOST).trim();
  const allowPublicBind = parseBool(env.IKBI_ALLOW_PUBLIC_BIND, false);

  // Safety seam: refuse to bind a public interface unless explicitly allowed.
  // Tailscale reachability does not require a public bind — Tailscale rides the
  // loopback/host interface, so the default localhost bind is reachable over the
  // tailnet while remaining invisible to the public internet.
  if (!isLoopback(bindHost) && !allowPublicBind) {
    throw new Error(
      `Refusing to bind non-loopback host "${bindHost}" without IKBI_ALLOW_PUBLIC_BIND=true. ` +
        `Set IKBI_BIND_HOST=127.0.0.1 (default) or opt in explicitly.`,
    );
  }

  const stateRootRaw = env.IKBI_STATE_ROOT?.trim();
  const stateRoot =
    stateRootRaw && stateRootRaw.length > 0
      ? isAbsolute(stateRootRaw)
        ? stateRootRaw
        : resolve(process.cwd(), stateRootRaw)
      : resolve(process.cwd(), "state");

  const logLevel = (env.IKBI_LOG_LEVEL ?? "info").trim();
  const runtimeEnv = (env.IKBI_ENV ?? env.NODE_ENV ?? "development").trim();

  return Object.freeze({
    version: pkg.version,
    port,
    bindHost,
    allowPublicBind,
    stateRoot,
    logLevel,
    env: runtimeEnv,
    provider: loadProviderConfig(env, stateRoot),
  });
}

/** The resolved configuration for this process. Loaded once at import. */
export const config: IkbiConfig = loadConfig();

/** Exposed for tests: load a config from an arbitrary env without touching the singleton. */
export { loadConfig };
