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
  /** Prompt-injection chokepoint configuration. */
  readonly injection: InjectionConfig;
  /** Agent identity / multi-tenancy configuration. */
  readonly identity: IdentityConfig;
  /** Concurrency-safe substrate configuration. */
  readonly substrate: SubstrateConfig;
  /** Receipt store (audit trail) configuration. */
  readonly receipt: ReceiptConfig;
}

/**
 * Configuration for the receipt store — a lean, retention-bounded OPERATIONAL log
 * (attributed, ordered, durable troubleshooting data). It is NOT a cryptographic
 * audit ledger; see the note in src/core/receipt/contract.ts.
 */
export interface ReceiptConfig {
  /** Directory for the receipt log. `IKBI_RECEIPT_DIR`, default `<stateRoot>/receipts`. */
  readonly dir: string;
  /**
   * Retention window in days. Receipts older than this are hard-deleted by
   * `prune()`. `IKBI_RECEIPT_RETENTION_DAYS`, default 30 (operator-configurable).
   */
  readonly retentionDays: number;
}

/** Configuration for the concurrency-safe substrate (atomic writes + locking). */
export interface SubstrateConfig {
  /** Default lock acquisition timeout. `IKBI_LOCK_TIMEOUT_MS`, default 10000. */
  readonly lockTimeoutMs: number;
  /**
   * Age after which a cross-process file lock is considered stale and may be
   * recovered (alongside dead-PID detection). `IKBI_LOCK_STALE_MS`, default 30000.
   */
  readonly lockStaleMs: number;
  /** Whether atomic writes fsync (durability). `IKBI_FSYNC`, default true. */
  readonly fsync: boolean;
}

/** Configuration for the agent identity / multi-tenancy layer. */
export interface IdentityConfig {
  /** Path to the JSON agents registry (who-can-call). `IKBI_IDENTITY_REGISTRY`, default `<stateRoot>/agents.json`. */
  readonly registryFile: string;
  /**
   * Bootstrap operator token (plaintext env, hashed at load — never stored raw).
   * Establishes the human operator identity. `IKBI_OPERATOR_TOKEN`. Undefined =
   * no bootstrapped operator (operator must be in the registry file, or absent).
   */
  readonly operatorToken: string | undefined;
  /** Agent id assigned to the bootstrapped operator. `IKBI_OPERATOR_AGENT_ID`, default "operator". */
  readonly operatorAgentId: string;
  /**
   * Pepper (global salt) for the token-hash KDF. Kept SEPARATE from the registry
   * so a stolen registry file resists offline brute force. `IKBI_IDENTITY_TOKEN_SALT`.
   * A built-in dev default is used if unset (logged as insecure — set it in prod).
   */
  readonly tokenSalt: string;
  /** True when `tokenSalt` is the insecure built-in default (for a startup warning). */
  readonly tokenSaltIsDefault: boolean;
}

/** Insecure built-in pepper used only when IKBI_IDENTITY_TOKEN_SALT is unset. */
const DEFAULT_TOKEN_SALT = "ikbi-dev-default-token-salt-change-me";

/** Configuration for the prompt-injection chokepoint. */
export interface InjectionConfig {
  /**
   * Max bytes of untrusted content the scanner inspects. Content beyond this is
   * still wrapped (wrapping is unconditional), but the scan is marked truncated.
   * `IKBI_INJECTION_MAX_SCAN_BYTES`, default 1_000_000.
   */
  readonly maxScanBytes: number;
  /**
   * Hard cap (bytes) on raw content accepted for wrapping. Content beyond this is
   * truncated with an explicit marker — closes the memory/context-DoS vector.
   * `IKBI_INJECTION_MAX_CONTENT_BYTES`, default 5_000_000.
   */
  readonly maxContentBytes: number;
  /** Max characters of a matched excerpt retained in findings/logs. `IKBI_INJECTION_EXCERPT_MAX`, default 160. */
  readonly excerptMaxChars: number;
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
    injection: {
      maxScanBytes: parsePositiveInt(
        "IKBI_INJECTION_MAX_SCAN_BYTES",
        env.IKBI_INJECTION_MAX_SCAN_BYTES,
        1_000_000,
      ),
      maxContentBytes: parsePositiveInt(
        "IKBI_INJECTION_MAX_CONTENT_BYTES",
        env.IKBI_INJECTION_MAX_CONTENT_BYTES,
        5_000_000,
      ),
      excerptMaxChars: parsePositiveInt(
        "IKBI_INJECTION_EXCERPT_MAX",
        env.IKBI_INJECTION_EXCERPT_MAX,
        160,
      ),
    },
    identity: loadIdentityConfig(env, stateRoot),
    receipt: loadReceiptConfig(env, stateRoot),
    substrate: {
      lockTimeoutMs: parsePositiveInt("IKBI_LOCK_TIMEOUT_MS", env.IKBI_LOCK_TIMEOUT_MS, 10_000),
      lockStaleMs: parsePositiveInt("IKBI_LOCK_STALE_MS", env.IKBI_LOCK_STALE_MS, 30_000),
      fsync: parseBool(env.IKBI_FSYNC, true),
    },
  });
}

function loadIdentityConfig(env: NodeJS.ProcessEnv, stateRoot: string): IdentityConfig {
  const regRaw = optStr(env.IKBI_IDENTITY_REGISTRY);
  const registryFile = regRaw
    ? isAbsolute(regRaw)
      ? regRaw
      : resolve(process.cwd(), regRaw)
    : resolve(stateRoot, "agents.json");

  const saltRaw = optStr(env.IKBI_IDENTITY_TOKEN_SALT);
  return {
    registryFile,
    operatorToken: optStr(env.IKBI_OPERATOR_TOKEN),
    operatorAgentId: optStr(env.IKBI_OPERATOR_AGENT_ID) ?? "operator",
    tokenSalt: saltRaw ?? DEFAULT_TOKEN_SALT,
    tokenSaltIsDefault: saltRaw === undefined,
  };
}

function loadReceiptConfig(env: NodeJS.ProcessEnv, stateRoot: string): ReceiptConfig {
  const dirRaw = optStr(env.IKBI_RECEIPT_DIR);
  const dir = dirRaw
    ? isAbsolute(dirRaw)
      ? dirRaw
      : resolve(process.cwd(), dirRaw)
    : resolve(stateRoot, "receipts");
  return {
    dir,
    retentionDays: parsePositiveInt("IKBI_RECEIPT_RETENTION_DAYS", env.IKBI_RECEIPT_RETENTION_DAYS, 30),
  };
}

/** The resolved configuration for this process. Loaded once at import. */
export const config: IkbiConfig = loadConfig();

/** Exposed for tests: load a config from an arbitrary env without touching the singleton. */
export { loadConfig };
