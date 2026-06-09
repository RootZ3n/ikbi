/**
 * ikbi governed-exec — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("governed-exec")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_GOVERNED_EXEC_`.
 *
 *   IKBI_GOVERNED_EXEC_ENABLED    on/off. DEFAULT ON. When disabled the executor
 *                                 DENIES every command (fail-closed — NOT a bypass).
 *   IKBI_GOVERNED_EXEC_ALLOWLIST  comma-separated allowed binaries (exact match).
 *                                 DEFAULT-DENY: a binary NOT on this list never runs
 *                                 (same posture as the egress host allowlist).
 *   IKBI_GOVERNED_EXEC_*_MS / _MAX_BUFFER  execution caps (see constants below).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("governed-exec");

/**
 * The default allowlist: a minimal, read-only-ish set PLUS the JS toolchain runners
 * (`node`, `npm`, `pnpm`) the builder needs to run Node scripts, install deps, and run
 * the project's checks. OPERATOR CHOICE (operational tuning): runners are dual-use — they
 * can run arbitrary code (`node -e`) — so this trades some default-deny strictness for a
 * builder that can actually drive a JS project out of the box. Shells are still excluded.
 *
 * The `IKBI_GOVERNED_EXEC_ALLOWLIST` env override is ADDITIVE (see `loadGovernedExecConfig`):
 * it ADDS to these defaults rather than replacing them, so an operator who allows extra
 * binaries (e.g. `python3,mkdir`) does NOT lose `git`/`ls`/`cat`/`echo` that the builder
 * relies on for version control and exploration.
 */
export const DEFAULT_ALLOWLIST: readonly string[] = Object.freeze(["git", "ls", "cat", "echo", "node", "npm", "pnpm"]);

/** Per-command wall-clock cap. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Max captured stdout/stderr bytes (output beyond this aborts the command). */
export const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
/** Per-HTTP-call wall-clock cap. */
export const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;
/** Tail length retained from stdout/stderr/body in receipts + results. */
export const OUTPUT_TAIL_CHARS = 2_000;

export interface GovernedExecConfig {
  /** When false, every run/fetch denies fail-closed (NOT a bypass). */
  readonly enabled: boolean;
  /** Allowed binaries (exact match). Empty = nothing runs (default-deny). */
  readonly allowlist: readonly string[];
  readonly execTimeoutMs: number;
  readonly maxBuffer: number;
  readonly networkTimeoutMs: number;
}

/**
 * Merge the env allowlist override with the defaults (deduped, order-stable: defaults first,
 * then any new operator-added binaries). ADDITIVE — the env list EXTENDS the defaults instead
 * of replacing them, so essential builder binaries (git/ls/cat/echo/...) survive an override
 * like `IKBI_GOVERNED_EXEC_ALLOWLIST=python3,mkdir`. An empty/absent override leaves exactly
 * the defaults.
 */
function mergeAllowlist(overrides: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...DEFAULT_ALLOWLIST, ...overrides])]);
}

/** Load the governed-exec config slice from `IKBI_GOVERNED_EXEC_*`. */
export function loadGovernedExecConfig(reader = env): GovernedExecConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    // ADDITIVE override (NOT a replace): merge the env list onto the defaults, deduped.
    allowlist: mergeAllowlist(reader.list("ALLOWLIST")),
    execTimeoutMs: reader.int("EXEC_TIMEOUT_MS", DEFAULT_EXEC_TIMEOUT_MS, { min: 1 }),
    maxBuffer: reader.int("MAX_BUFFER", DEFAULT_MAX_BUFFER, { min: 1 }),
    networkTimeoutMs: reader.int("NETWORK_TIMEOUT_MS", DEFAULT_NETWORK_TIMEOUT_MS, { min: 1 }),
  });
}

/** The process-wide governed-exec config. */
export const governedExecConfig: GovernedExecConfig = loadGovernedExecConfig();
