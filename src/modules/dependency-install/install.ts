/**
 * ikbi dependency-install — the installer (fail-closed, supply-chain-controlled).
 *
 * `run(request)` gates EVERY install through the shared enforcement layer and runs
 * ONLY lockfile-frozen, registry-allowlisted installs:
 *   1. config disabled            → deny (no exec);
 *   2. parent not validated       → deny (#10 anti-spoof);
 *   3. no allowlisted registry    → deny (default-deny);
 *   4. requested registry not on the allowlist → deny;
 *   5. lockfile missing/unreadable → deny (frozen mode needs it — its hash is evidence);
 *   6. gate-wall.evaluate(exec action) → deny on allow:false;
 *   7. dryRun → report intent (pm, mode, registry, lockfile hash) + the gate decision,
 *      execute NOTHING;
 *   8. execFile(pm, [frozen/ci flags, --registry <allowlisted>]) — ARRAY ARGS, NO
 *      shell — in the WORKSPACE worktree (never the target repo directly);
 *   9. rich receipt (pm, mode, registry, lockfile hash, exit code; kinds exec + file).
 *
 * HONEST RESIDUAL: the package-manager subprocess has its own network stack — its
 * traffic does NOT pass through the in-process egress guard. Compensating controls
 * are lockfile-only + registry-allowlist + receipts (see contract.ts header). This is
 * a documented gap, not pretend coverage.
 *
 * Copies governed-exec's array-args / no-shell / gate-before-exec pattern; it does
 * NOT import governed-exec.
 */

import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import { isValidatedIdentity } from "../../core/identity/index.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { ReceiptInput } from "../../core/receipt/contract.js";
import { asTier, autonomyForTier, TRUST_FLOOR } from "../../core/trust/index.js";
import { gateWall as coreGateWall, type GateWall } from "../gate-wall/index.js";
import { dependencyInstallConfig, OUTPUT_TAIL_CHARS, type DependencyInstallConfig } from "./config.js";
import {
  depinstallCompleted,
  depinstallFailed,
  depinstallGated,
  depinstallRequested,
  type DepInstallEventPayload,
} from "./events.js";
import type { DependencyInstall, InstallRequest, InstallResult, PackageManager } from "./contract.js";

const EVENT_SOURCE = "dependency-install";
const INSTALL_OPERATION = "depinstall.run";

/** Per-package-manager frozen-install spec. Both modes do NO new resolution. */
interface PmSpec {
  readonly lockfile: string;
  /** Frozen-install args (excluding `--registry`). */
  readonly args: readonly string[];
  readonly mode: string;
}
const PM_SPECS: Readonly<Record<PackageManager, PmSpec>> = Object.freeze({
  pnpm: { lockfile: "pnpm-lock.yaml", args: ["install", "--frozen-lockfile"], mode: "frozen-lockfile" },
  npm: { lockfile: "package-lock.json", args: ["ci"], mode: "ci" },
});

/** The exec primitive (array args, no shell). Tests substitute this. */
export type ExecFileFn = (
  binary: string,
  args: readonly string[],
  opts: { cwd?: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const promisifiedExecFile = promisify(nodeExecFile);
const defaultExecFile: ExecFileFn = (binary, args, opts) => promisifiedExecFile(binary, args as string[], opts);

/** Reads a lockfile's contents, or undefined when absent/unreadable. Tests substitute this. */
export type ReadLockfileFn = (workspacePath: string, lockfileName: string) => string | undefined;
const defaultReadLockfile: ReadLockfileFn = (workspacePath, lockfileName) => {
  try {
    return readFileSync(join(workspacePath, lockfileName), "utf8");
  } catch {
    return undefined;
  }
};

/** Injectable dependencies (tests substitute gateWall / receipts / execFile / readLockfile / publish). */
export interface DependencyInstallDeps {
  readonly config?: DependencyInstallConfig;
  readonly gateWall?: GateWall;
  readonly receipts?: { append: (input: ReceiptInput, identity: AgentIdentity) => Promise<unknown> };
  readonly publish?: (input: EventInput<DepInstallEventPayload>) => void;
  readonly execFile?: ExecFileFn;
  readonly readLockfile?: ReadLockfileFn;
}

function tail(s: string): string {
  return s.length > OUTPUT_TAIL_CHARS ? s.slice(-OUTPUT_TAIL_CHARS) : s;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Build a dependency installer. The default deps wire the live singletons + gate-wall. */
export function createDependencyInstall(deps: DependencyInstallDeps = {}): DependencyInstall {
  const config = deps.config ?? dependencyInstallConfig;
  const gateWall = deps.gateWall ?? coreGateWall;
  const receipts = deps.receipts ?? coreReceipts;
  const publish = deps.publish ?? ((input: EventInput<DepInstallEventPayload>) => void coreEvents.publish(input));
  const execFile = deps.execFile ?? defaultExecFile;
  const readLockfile = deps.readLockfile ?? defaultReadLockfile;
  const allowlist = new Set(config.registryAllowlist);

  function emit(
    event: { create: (p: DepInstallEventPayload, o?: { source?: string; attribution?: { identity?: AgentIdentity; operation?: string; runId?: string } }) => EventInput<DepInstallEventPayload> },
    payload: DepInstallEventPayload,
    identity: AgentIdentity | undefined,
    runId: string | undefined,
  ): void {
    publish(
      event.create(payload, {
        source: EVENT_SOURCE,
        attribution: { ...(identity !== undefined ? { identity } : {}), operation: INSTALL_OPERATION, ...(runId !== undefined ? { runId } : {}) },
      }),
    );
  }

  async function receipt(
    identity: AgentIdentity | undefined,
    outcome: ReceiptInput["outcome"],
    metadata: Record<string, unknown>,
    changes: ReceiptInput["changes"],
    requestId: string | undefined,
    project: string | undefined,
  ): Promise<void> {
    if (identity === undefined) return;
    await receipts.append(
      {
        operation: INSTALL_OPERATION,
        outcome,
        ...(changes !== undefined ? { changes } : {}),
        metadata,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(project !== undefined ? { project } : {}),
      },
      identity,
    );
  }

  async function run(request: InstallRequest): Promise<InstallResult> {
    const { parentCtx, workspace } = request;
    const pm = request.packageManager ?? config.defaultPackageManager;
    const identity = isValidatedIdentity(parentCtx.identity) ? parentCtx.identity.identity : undefined;
    const requestId = parentCtx.requestId;

    // FAIL-CLOSED GUARD: a runtime-invalid pm (a caller bypassing the TS type) must
    // NOT make PM_SPECS[pm] undefined and throw a TypeError outside the try/catch.
    // Deny gracefully BEFORE any spec dereference (and before the gate) — no execFile.
    if (!(pm in PM_SPECS)) {
      const reason = `unsupported package manager "${pm}"`;
      emit(depinstallFailed, { packageManager: pm, reason }, identity, requestId);
      await receipt(identity, { status: "rejected", error: reason }, { action: "exec", packageManager: pm }, undefined, requestId, workspace.id);
      return { installed: false, denied: true, reason };
    }
    const spec = PM_SPECS[pm];
    const base: DepInstallEventPayload = { packageManager: pm, mode: spec.mode };

    emit(depinstallRequested, base, identity, requestId);

    const deny = async (reason: string, gated = false, allow?: boolean): Promise<InstallResult> => {
      emit(gated ? depinstallGated : depinstallFailed, { ...base, reason, ...(allow !== undefined ? { allow } : {}) }, identity, requestId);
      await receipt(
        identity,
        { status: "rejected", error: reason },
        { action: "exec", packageManager: pm, mode: spec.mode, ...(allow !== undefined ? { allow } : {}) },
        undefined,
        requestId,
        workspace.id,
      );
      return { installed: false, denied: true, reason, mode: spec.mode };
    };

    // (1) disabled · (2) non-validated identity.
    if (!config.enabled) return deny("dependency-install disabled");
    if (identity === undefined) return deny("parent identity is not a validated identity");

    // (3)/(4) REGISTRY ALLOWLIST (default-deny; no "any" wildcard).
    if (allowlist.size === 0) return deny("no registry on the allowlist (default-deny)");
    let registry: string;
    if (request.registry !== undefined) {
      if (!allowlist.has(request.registry)) return deny(`registry "${request.registry}" is not on the allowlist`);
      registry = request.registry;
    } else {
      registry = config.registryAllowlist[0]!;
    }

    // (5) LOCKFILE-ONLY: frozen install requires a lockfile; read + hash it (evidence).
    const lockfileContents = readLockfile(workspace.path, spec.lockfile);
    if (lockfileContents === undefined) {
      return deny(`lockfile "${spec.lockfile}" is missing/unreadable — cannot run a frozen-lockfile install`);
    }
    const lockfileHash = sha256(lockfileContents);

    // (6) GATE-WALL — before any execution.
    const grant = autonomyForTier(asTier(identity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
    const installArgs = [...spec.args, "--registry", registry];
    const governance = await gateWall.evaluate({
      grant,
      action: { kind: "exec", command: pm, args: installArgs, sudo: false, purpose: "dependency install" },
      identity,
    });
    emit(depinstallGated, { ...base, registry, allow: governance.allow }, identity, requestId);
    if (!governance.allow) {
      await receipt(
        identity,
        { status: "rejected", error: governance.reason ?? "gate-wall denied the install" },
        { action: "exec", packageManager: pm, mode: spec.mode, registry, lockfileHash, allow: false },
        undefined,
        requestId,
        workspace.id,
      );
      return { installed: false, denied: true, reason: governance.reason ?? "gate-wall denied the install", lockfileHash, registry, mode: spec.mode };
    }

    // (7) dryRun ⇒ report intent + the allow decision; execute NOTHING.
    if (parentCtx.dryRun === true) {
      const reason = `dry-run: would ${pm} ${spec.mode} --registry ${registry} (lockfile ${spec.lockfile})`;
      emit(depinstallCompleted, { ...base, registry, allow: true, dryRun: true, reason }, identity, requestId);
      await receipt(
        identity,
        { status: "success", detail: reason },
        { action: "exec", packageManager: pm, mode: spec.mode, registry, lockfileHash, dryRun: true },
        undefined,
        requestId,
        workspace.id,
      );
      return { installed: false, reason, lockfileHash, registry, mode: spec.mode };
    }

    // (8) EXECUTE — array args, NO shell, in the workspace worktree. (9) rich receipt.
    const changes: ReceiptInput["changes"] = [
      { kind: "exec", target: pm, summary: `${pm} ${spec.mode} --registry ${registry}` },
      { kind: "file", target: "node_modules", summary: `installed from ${spec.lockfile} (sha256 ${lockfileHash.slice(0, 12)}…)` },
    ];
    try {
      const { stdout, stderr } = await execFile(pm, installArgs, { cwd: workspace.path, timeout: config.installTimeoutMs, maxBuffer: config.maxBuffer });
      emit(depinstallCompleted, { ...base, registry, allow: true, exitCode: 0 }, identity, requestId);
      await receipt(
        identity,
        { status: "success", detail: `${pm} ${spec.mode} ok` },
        { action: "exec", packageManager: pm, mode: spec.mode, registry, lockfileHash, exitCode: 0 },
        changes,
        requestId,
        workspace.id,
      );
      return { installed: true, exitCode: 0, lockfileHash, registry, mode: spec.mode, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      const exitCode = typeof e.code === "number" ? e.code : 1;
      const reason = `install exited ${exitCode}`;
      emit(depinstallFailed, { ...base, registry, allow: true, exitCode, reason }, identity, requestId);
      await receipt(
        identity,
        { status: "failure", error: reason, code: String(exitCode) },
        { action: "exec", packageManager: pm, mode: spec.mode, registry, lockfileHash, exitCode },
        undefined,
        requestId,
        workspace.id,
      );
      return {
        installed: false,
        exitCode,
        reason,
        lockfileHash,
        registry,
        mode: spec.mode,
        stdoutTail: tail(e.stdout ?? ""),
        stderrTail: tail(e.stderr ?? ""),
      };
    }
  }

  return { run };
}

/** The default process-wide dependency installer, wired to the live singletons + gate-wall. */
export const dependencyInstall: DependencyInstall = createDependencyInstall();
