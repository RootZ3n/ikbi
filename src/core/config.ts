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
  });
}

/** The resolved configuration for this process. Loaded once at import. */
export const config: IkbiConfig = loadConfig();

/** Exposed for tests: load a config from an arbitrary env without touching the singleton. */
export { loadConfig };
