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
import { DEFAULT_SANDBOX_MODE, type SandboxConfig, type SandboxMode } from "./sandbox.js";

const env = moduleEnv("governed-exec");

/**
 * The default allowlist: a minimal set covering version control, read-only exploration, and the
 * package managers the VERIFIER needs to run checks. Pure interpreters (`node`) and file dumpers
 * (`cat`) are intentionally NOT default-allowed — they are dual-use execution/exfiltration
 * primitives and must be explicitly operator-enabled.
 *
 * The package managers (`npm`/`npx`/`pnpm`/`yarn`) ARE default-allowed because the verifier's
 * fixed checks (`pnpm tsc --noEmit`, `pnpm test`) and the builder's in-loop `run_checks` cannot
 * run without them — denying them by default would make verification fail closed on EVERY repo,
 * not just untrusted ones. The dual-use risk is contained at a NARROWER layer instead: script
 * execution via these managers (`<mgr> run …`) and code-eval flags (`-e`/`--eval`/`-p`) are
 * policy-DENIED (see policy.ts / forbiddenEvalReason), so a terminal `pnpm run <anything>` is
 * still refused even though `pnpm` is allowlisted. The binary on the list ≠ arbitrary execution
 * through it.
 *
 * The `IKBI_GOVERNED_EXEC_ALLOWLIST` env override is ADDITIVE (see `loadGovernedExecConfig`):
 * it ADDS to these defaults rather than replacing them, so an operator who allows extra
 * binaries (e.g. `python3,mkdir`) does NOT lose the safe defaults the builder relies on.
 */
export const DEFAULT_ALLOWLIST: readonly string[] = Object.freeze([
  // version control
  "git",
  // read-only exploration (safe for doc/audit/analysis tasks)
  // NOTE: cat is intentionally excluded — the builder uses read_file MCP tool instead.
  //       cat can dump .env / secrets and must remain operator opt-in.
  "ls", "head", "tail", "wc", "find", "grep", "echo",
  // package managers + typecheck driver (REQUIRED for verifier checks and run_checks). Allowlisted
  // by default; `<mgr> run …` / code-eval flags remain policy-denied (script exec is gated separately).
  "npm", "npx", "pnpm", "yarn",
  // language-native toolchains (REQUIRED for multi-language verification). cargo/go/python3 run
  // project-owned code by design — the governed-exec policy layer blocks dangerous flags/patterns.
  "cargo", "go", "python3", "godot",
]);

/** Per-command wall-clock cap. NOTE: applies to FOREGROUND commands only — a background job (spawned
 *  detached via `background:true`) has no timeout and runs until it exits or is killed. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Grace (ms) between SIGTERM and the follow-up SIGKILL when a background job is killed. */
export const DEFAULT_JOB_KILL_GRACE_MS = 5_000;
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
  /** Grace (ms) between SIGTERM and SIGKILL when killing a background job. */
  readonly jobKillGraceMs: number;
  /**
   * OS-LEVEL SANDBOX policy for risky subprocesses (F1). `auto` (default) sandboxes risky commands
   * via bubblewrap when it works and FAILS CLOSED (denies) when it does not; `required` additionally
   * treats a missing sandbox as a hard error; `off` disables sandboxing (NOT for production — unit
   * tests / non-Linux dev only). See sandbox.ts.
   */
  readonly sandbox: SandboxConfig;
}

/** Parse the sandbox mode env (`auto` | `off` | `required`), defaulting to the safe `auto`. */
function parseSandboxMode(raw: string | undefined): SandboxMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "required" || v === "auto" ? v : DEFAULT_SANDBOX_MODE;
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
    jobKillGraceMs: reader.int("JOB_KILL_GRACE_MS", DEFAULT_JOB_KILL_GRACE_MS, { min: 1 }),
    sandbox: Object.freeze({
      mode: parseSandboxMode(reader.str("SANDBOX")),
      // IKBI_GOVERNED_EXEC_TRUSTED_LOCAL — explicit, default-OFF override; see SandboxConfig.
      trustedLocalOverride: reader.bool("TRUSTED_LOCAL", false),
    }),
  });
}

/** The process-wide governed-exec config. */
export const governedExecConfig: GovernedExecConfig = loadGovernedExecConfig();
