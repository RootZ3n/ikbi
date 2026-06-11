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
  /**
   * Allow starting on the insecure built-in trust HMAC key / token salt (dev only).
   * `IKBI_ALLOW_INSECURE_DEV_KEYS`, default false. When false and either key is
   * defaulted, `loadConfig` refuses to start (see the gate in `loadConfig`).
   */
  readonly allowInsecureDevKeys: boolean;
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
  /** Trust system (governance) configuration. */
  readonly trust: TrustConfig;
  /** Event bus configuration. */
  readonly events: EventsConfig;
  /** Workspace primitive (isolated worktrees) configuration. */
  readonly workspace: WorkspaceConfig;
}

/** Configuration for the disposable-workspace primitive. */
export interface WorkspaceConfig {
  /** Root dir for worktrees + the workspace registry. `IKBI_WORKSPACE_ROOT`, default `<stateRoot>/workspaces`. */
  readonly root: string;
  /** Max concurrently-allocated workspaces (bounds disk). `IKBI_WORKSPACE_MAX`, default 32. */
  readonly max: number;
}

/** Configuration for the in-process event bus. */
export interface EventsConfig {
  /**
   * Default per-subscriber bounded queue size. Beyond this, the bus drops per the
   * subscription's drop policy (loudly logged) — an unbounded queue would be a
   * memory leak under load. `IKBI_EVENT_MAX_QUEUE`, default 1000.
   */
  readonly maxQueue: number;
}

/** Configuration for the trust system (earned tiers + deterministic transitions). */
export interface TrustConfig {
  /** Directory for per-agent durable trust state. `IKBI_TRUST_DIR`, default `<stateRoot>/trust`. */
  readonly dir: string;
  /** Consecutive substantive successes required to promote one tier. `IKBI_TRUST_PROMOTE_STREAK`, default 20. */
  readonly promoteStreak: number;
  /** Consecutive failures required to demote one tier. `IKBI_TRUST_DEMOTE_STREAK`, default 3. */
  readonly demoteStreak: number;
  /** Min DISTINCT substantive operations a promotion streak must span (anti-farming). `IKBI_TRUST_PROMOTE_MIN_DISTINCT_OPS`, default 2. */
  readonly promoteMinDistinctOps: number;
  /**
   * MAC key for trust-state integrity, kept SEPARATE from the trust dir so a
   * hand-edited/forged trust doc is rejected at load (an agent with a write
   * primitive cannot self-promote by editing the file). `IKBI_TRUST_HMAC_KEY`.
   * A built-in dev default is used if unset (logged as insecure).
   */
  readonly hmacKey: string;
  /** True when `hmacKey` is the insecure built-in default (for a startup warning). */
  readonly hmacKeyIsDefault: boolean;
}

/** Insecure built-in trust MAC key used only when IKBI_TRUST_HMAC_KEY is unset. */
const DEFAULT_TRUST_HMAC_KEY = "ikbi-dev-default-trust-hmac-key-change-me";

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
   * Bootstrap WORKER token (plaintext env, hashed at load — never stored raw). When
   * set, registers a claimable worker agent so the worker-model orchestrator's
   * roleClaim can resolve a real role identity. `IKBI_WORKER_TOKEN`. Undefined =
   * no worker agent registered → roleClaim fails closed → no run.
   */
  readonly workerToken: string | undefined;
  /** Agent id for the bootstrapped worker agent. `IKBI_WORKER_AGENT_ID`, default "worker". */
  readonly workerAgentId: string;
  /**
   * The worker agent's `defaultTrustTier`. `IKBI_WORKER_TRUST_TIER`, default "trusted".
   * A FLOOR, not a ceiling: the orchestrator's #10 clamp caps any spawned role at the
   * dispatching parent's tier, so this cannot grant a role more trust than the operator
   * who dispatched the run.
   */
  readonly workerTrustTier: string;
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
  /** DeepSeek direct API endpoint (OpenAI-compatible). */
  readonly deepseek: ProviderEndpointConfig;
  /** MiniMax direct API endpoint (OpenAI-compatible). */
  readonly minimax: ProviderEndpointConfig;
  /**
   * Default logical model ids for the standard roles (config-driven, not hardcoded
   * downstream). `builder` has its OWN id (IKBI_MODEL_BUILDER) that falls through to the
   * driver when unset. `competitiveModels` (IKBI_COMPETITIVE_MODELS) is the optional
   * head-to-head list — competitive mode races one candidate per listed model.
   */
  readonly defaultModels: {
    readonly driver: string;
    readonly builder: string;
    readonly critic: string;
    readonly competitiveModels?: readonly string[];
  };
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
      // Direct MiMo's real endpoint. OpenAI-SHAPED but not OpenAI-compatible: api-key
      // auth (keyless + an api-key extra-header, not Bearer), max_completion_tokens
      // (tokenFieldName), and a non-standard thinking field (extraBody) — all set at the
      // roster level. Override the base URL via IKBI_MIMO_BASE_URL.
      baseUrl: optStr(env.IKBI_MIMO_BASE_URL) ?? "https://api.xiaomimimo.com/v1",
      apiKey: optStr(env.IKBI_MIMO_API_KEY),
    },
    openrouter: {
      baseUrl: optStr(env.IKBI_OPENROUTER_BASE_URL) ?? "https://openrouter.ai/api/v1",
      apiKey: optStr(env.IKBI_OPENROUTER_API_KEY),
      referer: optStr(env.IKBI_OPENROUTER_REFERER),
      title: optStr(env.IKBI_OPENROUTER_TITLE),
    },
    deepseek: {
      // DeepSeek's OpenAI-compatible endpoint. Override via IKBI_DEEPSEEK_BASE_URL.
      baseUrl: optStr(env.IKBI_DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com/v1",
      apiKey: optStr(env.IKBI_DEEPSEEK_API_KEY),
    },
    minimax: {
      // MiniMax's OpenAI-compatible endpoint. Override via IKBI_MINIMAX_BASE_URL.
      baseUrl: optStr(env.IKBI_MINIMAX_BASE_URL) ?? "https://api.minimax.chat/v1",
      apiKey: optStr(env.IKBI_MINIMAX_API_KEY),
    },
    defaultModels: {
      driver: optStr(env.IKBI_MODEL_DRIVER) ?? "mimo-v2.5",
      // The builder's own model — falls through to the driver when unset (default unchanged).
      builder: optStr(env.IKBI_MODEL_BUILDER) ?? optStr(env.IKBI_MODEL_DRIVER) ?? "mimo-v2.5",
      critic: optStr(env.IKBI_MODEL_CRITIC) ?? "deepseek-v4-pro",
      // Optional head-to-head list (comma-separated). Empty/unset ⇒ undefined.
      ...(() => {
        const list = optStr(env.IKBI_COMPETITIVE_MODELS)?.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        return list !== undefined && list.length > 0 ? { competitiveModels: list } : {};
      })(),
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

  // Safety seam (mirrors the public-bind gate): refuse to start the process on the
  // insecure built-in trust MAC key or token-hash pepper. A governance core whose
  // own integrity keys are guessable would violate ikbi's fail-closed posture, so
  // the refusal fires HERE — at config load, before the trust and identity modules
  // construct from these values — leaving no window in which the system runs on
  // default keys. Explicit env objects are authoritative; callers that pass one
  // must include IKBI_ALLOW_INSECURE_DEV_KEYS=true or real keys themselves.
  const allowInsecureDevKeys = parseBool(env.IKBI_ALLOW_INSECURE_DEV_KEYS, false);
  const hmacKeyIsDefault = optStr(env.IKBI_TRUST_HMAC_KEY) === undefined;
  const tokenSaltIsDefault = optStr(env.IKBI_IDENTITY_TOKEN_SALT) === undefined;
  if ((hmacKeyIsDefault || tokenSaltIsDefault) && !allowInsecureDevKeys) {
    throw new Error(
      `Refusing to start with insecure default trust keys without IKBI_ALLOW_INSECURE_DEV_KEYS=true. ` +
        `Set IKBI_TRUST_HMAC_KEY and IKBI_IDENTITY_TOKEN_SALT, or opt in explicitly for development.`,
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
    allowInsecureDevKeys,
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
    trust: {
      dir: optStr(env.IKBI_TRUST_DIR)
        ? isAbsolute(env.IKBI_TRUST_DIR as string)
          ? (env.IKBI_TRUST_DIR as string)
          : resolve(process.cwd(), env.IKBI_TRUST_DIR as string)
        : resolve(stateRoot, "trust"),
      promoteStreak: parsePositiveInt("IKBI_TRUST_PROMOTE_STREAK", env.IKBI_TRUST_PROMOTE_STREAK, 20),
      demoteStreak: parsePositiveInt("IKBI_TRUST_DEMOTE_STREAK", env.IKBI_TRUST_DEMOTE_STREAK, 3),
      promoteMinDistinctOps: parsePositiveInt(
        "IKBI_TRUST_PROMOTE_MIN_DISTINCT_OPS",
        env.IKBI_TRUST_PROMOTE_MIN_DISTINCT_OPS,
        2,
      ),
      hmacKey: optStr(env.IKBI_TRUST_HMAC_KEY) ?? DEFAULT_TRUST_HMAC_KEY,
      hmacKeyIsDefault: optStr(env.IKBI_TRUST_HMAC_KEY) === undefined,
    },
    events: {
      maxQueue: parsePositiveInt("IKBI_EVENT_MAX_QUEUE", env.IKBI_EVENT_MAX_QUEUE, 1000),
    },
    workspace: {
      root: optStr(env.IKBI_WORKSPACE_ROOT)
        ? isAbsolute(env.IKBI_WORKSPACE_ROOT as string)
          ? (env.IKBI_WORKSPACE_ROOT as string)
          : resolve(process.cwd(), env.IKBI_WORKSPACE_ROOT as string)
        : resolve(stateRoot, "workspaces"),
      max: parsePositiveInt("IKBI_WORKSPACE_MAX", env.IKBI_WORKSPACE_MAX, 32),
    },
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
    workerToken: optStr(env.IKBI_WORKER_TOKEN),
    workerAgentId: optStr(env.IKBI_WORKER_AGENT_ID) ?? "worker",
    workerTrustTier: optStr(env.IKBI_WORKER_TRUST_TIER) ?? "trusted",
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

/**
 * The raw process environment this config was loaded from — the per-module config
 * SEAM. core `config.ts` stays frozen to CORE knobs; a MODULE never adds a field
 * to `IkbiConfig`. Instead it owns its own typed slice by reading its `IKBI_*`
 * block from here via `moduleEnv(...)` (see `src/core/module-config.ts`). This is
 * a frozen, shallow snapshot taken at load — modules read, never mutate.
 */
export const configEnv: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...process.env });
