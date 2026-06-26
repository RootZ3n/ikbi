/**
 * ikbi governed-exec — its events (namespaced `govexec.*` per module plan ## 8).
 *
 * Published with `source: "governed-exec"` and identity attribution so every gated
 * execution — the request, a fail-closed deny, a completion, a failure — is
 * observable live. Payloads carry the binary + arg COUNT + sudo flag + verdict +
 * exit code/status — NEVER the full args, URL, or body.
 */

import { defineEvent } from "../../core/events/index.js";

/** Payload common to the govexec lifecycle events (fields populated as known). */
export interface GovExecEventPayload {
  /** "exec" for a command, "network" for an HTTP call. */
  readonly kind: "exec" | "network";
  /** The binary (exec) or method (network) — never the full URL. */
  readonly command: string;
  /** Argument count (exec) — never the args themselves. */
  readonly argCount?: number;
  /** Whether the command ran under sudo. */
  readonly sudo?: boolean;
  /** The gate verdict, when a gate evaluation occurred. */
  readonly allow?: boolean;
  /** Command exit code (exec executed/failed). */
  readonly exitCode?: number;
  /** HTTP status (network executed/failed). */
  readonly status?: number;
  /** Human/audit reason (deny/failure). */
  readonly reason?: string;
  /** True when reported under dry-run (nothing executed). */
  readonly dryRun?: boolean;
  /** True when the command was spawned as a detached BACKGROUND job (no wait, no timeout). */
  readonly background?: boolean;
  /** Sandbox mode applied to this exec: "bwrap" (confined), "none" (safe cmd), or absent. */
  readonly sandbox?: "bwrap" | "none" | "unavailable";
  /** Risk classification kind (interpreter/package-install/…/safe) when computed. */
  readonly risk?: string;
}

/** Emitted when an execution is requested (before any gate/run). */
export const govexecRequested = defineEvent<GovExecEventPayload>("govexec.requested");
/** Emitted when an execution is refused fail-closed (disabled / allowlist / gate / identity). */
export const govexecDenied = defineEvent<GovExecEventPayload>("govexec.denied");
/** Emitted when a governed execution completes (exec ran / HTTP returned). */
export const govexecExecuted = defineEvent<GovExecEventPayload>("govexec.executed");
/** Emitted when a governed execution fails (non-zero exit / network error / SSRF block). */
export const govexecFailed = defineEvent<GovExecEventPayload>("govexec.failed");
