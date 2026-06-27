/**
 * ikbi dependency-install — its events (namespaced `depinstall.*` per module plan ## 8).
 *
 * Published with `source: "dependency-install"` and identity attribution so every
 * install — the request, the gate verdict, completion, failure — is observable live.
 * Payloads carry the package manager + mode + registry + verdict + exit code — NEVER
 * the lockfile contents.
 */

import { defineEvent } from "../../core/events/index.js";
import type { PackageManager } from "./contract.js";

/** Payload common to the install lifecycle events (fields populated as known). */
export interface DepInstallEventPayload {
  readonly packageManager: PackageManager;
  /** The frozen mode ("frozen-lockfile" / "ci"). */
  readonly mode?: string;
  /** The allowlisted registry used. */
  readonly registry?: string;
  /** The gate verdict, when a gate evaluation occurred. */
  readonly allow?: boolean;
  /** Install exit code (completed/failed). */
  readonly exitCode?: number;
  /** Human/audit reason (deny / failure). */
  readonly reason?: string;
  /** True when reported under dry-run (nothing executed). */
  readonly dryRun?: boolean;
  /** OS-sandbox mode applied to the install subprocess: "bwrap" | "none" | "unavailable". */
  readonly sandbox?: "bwrap" | "none" | "unavailable";
}

/** Emitted when an install is requested (before any gate/exec). */
export const depinstallRequested = defineEvent<DepInstallEventPayload>("depinstall.requested");
/** Emitted with the gate verdict (allow/deny). */
export const depinstallGated = defineEvent<DepInstallEventPayload>("depinstall.gated");
/** Emitted when an install completes cleanly (exit 0) or under dry-run. */
export const depinstallCompleted = defineEvent<DepInstallEventPayload>("depinstall.completed");
/** Emitted when an install is refused fail-closed or fails (non-zero exit / error). */
export const depinstallFailed = defineEvent<DepInstallEventPayload>("depinstall.failed");
