/**
 * ikbi dependency-install — THE MODULE CONTRACT (versioned).
 *
 * Standalone, supply-chain-controlled package installation. It gates every install
 * through gate-wall's exec action and writes its own rich receipt; it copies
 * governed-exec's array-args / no-shell / gate-before-exec pattern WITHOUT importing
 * governed-exec.
 *
 * ── HONEST RESIDUAL (read this) ──────────────────────────────────────────────
 * The in-process egress guard wraps `globalThis.fetch`. A package-manager SUBPROCESS
 * (pnpm/npm) has its OWN network stack — its outbound traffic does NOT pass through
 * that guard and CANNOT be intercepted in-process. We do not pretend otherwise. The
 * COMPENSATING CONTROLS for the supply-chain risk are, in order:
 *   1. LOCKFILE-ONLY (frozen): installs run `--frozen-lockfile` (pnpm) / `ci` (npm) —
 *      no new resolutions; exactly the lockfile's pinned versions + integrity hashes.
 *      You cannot pull a package that is not already pinned+hashed in the committed
 *      lockfile. This is the primary control.
 *   2. REGISTRY ALLOWLIST: the package manager is invoked with an explicit
 *      `--registry` from a config allowlist (default-deny — no registry, no install).
 *   3. RECEIPTS: package manager, mode, registry, lockfile hash, exit code recorded.
 * This residual is named the way egress's resolve-then-connect TOCTOU is named — a
 * documented gap with compensating controls, not silent pretend-coverage.
 *
 * No frozen-core / gate-wall contract change.
 *
 * CONTRACT_VERSION changelog (newest on top):
 *   1.0.0 — initial dependency-install contract: InstallRequest/InstallResult for
 *           lockfile-only, registry-allowlisted, gate-walled, receipted installation
 *           scoped to a workspace worktree. Honest residual: subprocess network is
 *           out of the in-process egress guard's scope (compensating controls above).
 */

import type { OperationContext } from "../../core/identity/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";

/** Semantic version of the dependency-install contract. Bump on breaking change. */
export const CONTRACT_VERSION = "1.0.0";

/** Supported package managers (both run in a frozen/no-resolution mode). */
export type PackageManager = "pnpm" | "npm";

/** A request to install dependencies into a workspace worktree (lockfile-only). */
export interface InstallRequest {
  /** The caller's operation context (must carry a ValidatedIdentity). */
  readonly parentCtx: OperationContext;
  /** The isolated worktree the install runs in (never the target repo directly). */
  readonly workspace: WorkspaceHandle;
  /** Package manager (default: config DEFAULT_PACKAGE_MANAGER). */
  readonly packageManager?: PackageManager;
  /**
   * Optional explicit registry — MUST be on the config allowlist (else denied). When
   * omitted, the first allowlisted registry is used. There is no "any registry" value.
   */
  readonly registry?: string;
}

/**
 * The outcome of an install. `installed` is true only on a clean (exit 0) frozen
 * install; a non-zero exit is `installed:false` with the `exitCode`. `denied` marks
 * a fail-closed policy refusal (nothing ran). Output is tail-truncated; lockfile
 * CONTENTS are never returned — only its `lockfileHash`.
 */
export interface InstallResult {
  readonly installed: boolean;
  readonly denied?: boolean;
  readonly reason?: string;
  readonly exitCode?: number;
  /** SHA-256 of the lockfile that pinned the install (evidence; not the contents). */
  readonly lockfileHash?: string;
  /** The allowlisted registry the install used. */
  readonly registry?: string;
  /** The frozen mode used ("frozen-lockfile" / "ci"). */
  readonly mode?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
}

/** The dependency-install surface. */
export interface DependencyInstall {
  run(request: InstallRequest): Promise<InstallResult>;
}
