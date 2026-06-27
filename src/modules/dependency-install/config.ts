/**
 * ikbi dependency-install — its OWN config slice (per-module config seam).
 *
 * Read ONLY through `moduleEnv("dependency-install")` — never `configEnv` directly
 * (module plan ## 8). The reader auto-prefixes `IKBI_DEPENDENCY_INSTALL_`.
 *
 *   IKBI_DEPENDENCY_INSTALL_ENABLED            on/off. DEFAULT ON. Disabled ⇒ every
 *                                              install DENIES (fail-closed, not a bypass).
 *   IKBI_DEPENDENCY_INSTALL_REGISTRY_ALLOWLIST comma-separated allowed registries
 *                                              (exact match). DEFAULT-DENY: empty ⇒
 *                                              NO install runs. There is deliberately
 *                                              NO "any registry" wildcard.
 *   IKBI_DEPENDENCY_INSTALL_PACKAGE_MANAGER    default pm ("pnpm" | "npm").
 *   IKBI_DEPENDENCY_INSTALL_*_MS / _MAX_BUFFER execution caps (constants below).
 */

import { moduleEnv } from "../../core/module-config.js";
import type { PackageManager } from "./contract.js";

const env = moduleEnv("dependency-install");

/**
 * Default registry allowlist. The canonical public npm registry only — the operator
 * opts additional (e.g. internal mirror) registries in via the env override. Empty
 * would be the strictest default-deny; we seed the one trusted public registry.
 */
export const DEFAULT_REGISTRY_ALLOWLIST: readonly string[] = Object.freeze(["https://registry.npmjs.org/"]);

/** Default package manager. */
export const DEFAULT_PACKAGE_MANAGER: PackageManager = "pnpm";

/** Install wall-clock cap (installs can be slow; generous but bounded). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
/** Max captured stdout/stderr bytes. */
export const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
/** Tail length retained from stdout/stderr in receipts + results. */
export const OUTPUT_TAIL_CHARS = 2_000;

export interface DependencyInstallConfig {
  /** When false, every install denies fail-closed (NOT a bypass). */
  readonly enabled: boolean;
  /** Allowed registries (exact match). Empty = nothing installs (default-deny). */
  readonly registryAllowlist: readonly string[];
  readonly defaultPackageManager: PackageManager;
  readonly installTimeoutMs: number;
  readonly maxBuffer: number;
  /**
   * Run package lifecycle scripts (preinstall/install/postinstall)? DEFAULT FALSE ⇒ `--ignore-scripts`
   * — a postinstall is arbitrary code execution (the F1 escape vector), so it is OFF by default. When
   * true, scripts run but ONLY inside the bwrap sandbox; with the sandbox unavailable an install that
   * would run scripts FAILS CLOSED unless `sandboxTrustedLocalOverride` is set.
   */
  readonly allowScripts: boolean;
  /** OS-sandbox policy for the install subprocess: `auto` (default) | `off` | `required`. */
  readonly sandboxMode: "auto" | "off" | "required";
  /** Explicit, default-OFF override: when scripts are allowed but no sandbox exists, run anyway (noisy). */
  readonly sandboxTrustedLocalOverride: boolean;
}

function asPackageManager(v: string | undefined): PackageManager {
  return v === "npm" ? "npm" : "pnpm";
}

function asSandboxMode(v: string | undefined): "auto" | "off" | "required" {
  const s = (v ?? "").trim().toLowerCase();
  return s === "off" || s === "required" ? s : "auto";
}

/** Load the dependency-install config slice from `IKBI_DEPENDENCY_INSTALL_*`. */
export function loadDependencyInstallConfig(reader = env): DependencyInstallConfig {
  return Object.freeze({
    enabled: reader.bool("ENABLED", true),
    registryAllowlist: reader.list("REGISTRY_ALLOWLIST", DEFAULT_REGISTRY_ALLOWLIST),
    defaultPackageManager: asPackageManager(reader.str("PACKAGE_MANAGER")),
    installTimeoutMs: reader.int("TIMEOUT_MS", DEFAULT_INSTALL_TIMEOUT_MS, { min: 1 }),
    maxBuffer: reader.int("MAX_BUFFER", DEFAULT_MAX_BUFFER, { min: 1 }),
    allowScripts: reader.bool("ALLOW_SCRIPTS", false),
    sandboxMode: asSandboxMode(reader.str("SANDBOX")),
    sandboxTrustedLocalOverride: reader.bool("TRUSTED_LOCAL", false),
  });
}

/** The process-wide dependency-install config. */
export const dependencyInstallConfig: DependencyInstallConfig = loadDependencyInstallConfig();
