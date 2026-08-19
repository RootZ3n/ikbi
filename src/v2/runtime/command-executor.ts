/**
 * THE BUILDER COMMAND EXECUTOR — the ONLY thing that runs a model-requested command in v2.
 *
 * It holds the capability the builder controller and the pure command authority deliberately do
 * not: the governed executor and the tree prober. It enforces, in order, every layer of V2-015:
 *
 *   1. POLICY — `evaluateCommand` refuses anything not on the tiny read-only allowlist BEFORE a
 *      process is spawned. A refused request never reaches governed-exec.
 *   2. CWD CONFINEMENT — the model's relative cwd is realpath-resolved and proven to stay inside
 *      the candidate worktree (no `..`, no absolute path, no symlink escape).
 *   3. GOVERNED EXECUTION — the command runs through the SAME governed-exec authority as the
 *      verifier, but with `verifier:false` (a model can never authorize package scripts) and with
 *      the candidate bound READ-ONLY: the single writable host root handed to the sandbox is a
 *      throwaway temp dir, NOT the candidate, so a risky subprocess physically cannot write it.
 *   4. TREE BEFORE == AFTER — the candidate tree is hashed before and after every command; any
 *      change is a HARD safety failure (`build.command_workspace_mutated`) that stops the build.
 *      OS-independent and authoritative.
 *
 * It NEVER mints an observation and NEVER touches the mutation authority: a command can inspect
 * the workspace, never change it. To edit a file the model must still call read_file (which mints
 * the observation) and a state-bound write. There is no `child_process` here — every process is
 * spawned by governed-exec, which a static guard enforces.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { createGovernedExec } from "../../modules/governed-exec/index.js";
import type { GovernedExec } from "../../modules/governed-exec/index.js";
import { classifyCommandRisk } from "../../modules/governed-exec/sandbox.js";
import { AgentRegistry, hashToken } from "../../core/identity/registry.js";
import { IdentityResolver, beginOperation } from "../../core/identity/resolver.js";
import { randomBytes } from "node:crypto";
import pino from "pino";
import type { OperationContext } from "../../core/identity/index.js";
import type { TreeProbe } from "../core/verification.js";
import {
  boundCommandOutput,
  buildCommandRecord,
  commandLaunchedOutcome,
  commandRefusalOutcome,
  commandWorkspaceMutatedFailure,
  evaluateCommand,
  validateRelativeCwd,
  type BuilderCommandCapability,
  type BuilderCommandPolicy,
  type BuilderCommandResult,
  type CommandSandboxMode,
} from "../core/command.js";

/** governed-exec stamps this exit code when its streaming path kills a timed-out command. */
const TIMEOUT_EXIT_CODE = 124;

/**
 * The narrow governed-execution seam this executor needs. Production wires the real
 * governed-exec; a test injects a fake to stay hermetic and off the host.
 */
export interface CommandTransport {
  run(input: {
    readonly program: string;
    readonly args: readonly string[];
    /** Absolute, already-confined working directory (inside the candidate worktree). */
    readonly cwd: string;
    readonly timeoutMs: number;
    /** The single WRITABLE host root handed to the OS sandbox — a throwaway temp, NOT the candidate. */
    readonly writableTempRoot: string;
  }): Promise<CommandTransportResult>;
}

export interface CommandTransportResult {
  readonly launched: boolean;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  /** The FULL combined output (bounded later). */
  readonly output: string;
  readonly durationMs: number;
  /** Why nothing ran, when `launched` is false (denied binary / gate deny). */
  readonly refusedReason?: string;
}

/**
 * Mint a self-contained, trusted operation context for the builder terminal. A one-agent registry
 * with a fresh random token — nothing else on the box knows it, so this identity cannot be spoofed.
 * It grants NO verifier authority: every command runs with `verifier:false`.
 */
function mintTerminalContext(): OperationContext {
  const token = randomBytes(32).toString("hex");
  const registry = new AgentRegistry({
    agents: [{ agentId: "ikbi-v2-builder-terminal", kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken(token)] }],
  });
  const resolver = new IdentityResolver({ registry, logger: pino({ enabled: false }) });
  return beginOperation(resolver.resolve({ token }), { requestId: `v2-terminal-${randomBytes(4).toString("hex")}` });
}

/** Build the production governed-exec-backed transport. verifier is ALWAYS false — a model may
 *  never authorize package scripts through the terminal. */
export function createGovernedCommandTransport(deps: { readonly governedExec?: Pick<GovernedExec, "run">; readonly now?: () => number } = {}): CommandTransport {
  const now = deps.now ?? Date.now;
  const parentCtx = mintTerminalContext();
  let exec: Pick<GovernedExec, "run"> | undefined = deps.governedExec;
  const executor = (): Pick<GovernedExec, "run"> => (exec ??= createGovernedExec());

  return {
    async run(input): Promise<CommandTransportResult> {
      const startedAt = now();
      let full = "";
      const res = await executor().run({
        parentCtx,
        command: input.program,
        args: [...input.args],
        cwd: input.cwd,
        // The candidate stays READ-ONLY: the sandbox's single writable root is this throwaway temp.
        worktreeRoot: input.writableTempRoot,
        // A MODEL COMMAND IS NEVER A VERIFIER. It cannot run package scripts.
        verifier: false,
        purpose: "v2 builder read-only terminal",
        timeoutMs: input.timeoutMs,
        onOutput: (chunk) => { full += chunk; },
      });
      const durationMs = now() - startedAt;
      if (!res.executed) {
        return { launched: false, timedOut: false, output: full, durationMs, refusedReason: res.reason ?? (res.denied === true ? "denied" : "not executed") };
      }
      const exitCode = res.exitCode ?? 1;
      return { launched: true, exitCode, timedOut: exitCode === TIMEOUT_EXIT_CODE, output: full, durationMs };
    },
  };
}

/** Is `child` the same as, or contained within, `parent`? Both must be realpath'd first. */
function isContained(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export interface CommandCapabilityDeps {
  readonly transport: CommandTransport;
  readonly treeProbe: TreeProbe;
  readonly policy: BuilderCommandPolicy;
}

/**
 * Build the builder command capability over one policy. Stateless across commands except for the
 * frozen policy — every command re-probes the tree, so nothing leaks between them.
 */
export function createCommandCapability(deps: CommandCapabilityDeps): BuilderCommandCapability {
  const { transport, treeProbe, policy } = deps;

  return {
    async run(request): Promise<BuilderCommandResult> {
      const { program, args, cwd } = request;

      // 1. POLICY — refuse anything not provably read-only, before any process is spawned.
      const verdict = evaluateCommand(policy, { program, args });
      if (!verdict.ok) {
        return { outcome: commandRefusalOutcome({ program, args, cwd, code: verdict.code ?? "refused", detail: verdict.detail ?? "not allowed" }) };
      }

      // 2. CWD CONFINEMENT — pure precheck, then authoritative realpath containment.
      const rel = validateRelativeCwd(cwd);
      if (!rel.ok) {
        return { outcome: commandRefusalOutcome({ program, args, cwd, code: "cwd_escapes_workspace", detail: rel.detail }) };
      }
      let workspaceRealpath: string;
      let absCwd: string;
      try {
        workspaceRealpath = realpathSync(request.workspacePath);
        absCwd = realpathSync(resolve(workspaceRealpath, rel.normalized));
      } catch (err) {
        return { outcome: commandRefusalOutcome({ program, args, cwd, code: "cwd_escapes_workspace", detail: `cwd could not be resolved inside the workspace: ${err instanceof Error ? err.message : String(err)}` }) };
      }
      if (!isContained(workspaceRealpath, absCwd)) {
        return { outcome: commandRefusalOutcome({ program, args, cwd, code: "cwd_escapes_workspace", detail: `cwd "${cwd}" resolves outside the candidate workspace` }) };
      }

      // 3. TREE BEFORE. The authoritative read-only proof is captured around the command.
      const treeBefore = await treeProbe.treeOf(request.workspacePath);

      // A throwaway writable temp for the sandbox's single writable root — NOT the candidate.
      const tempRoot = mkdtempSync(join(tmpdir(), "ikbi-v2-cmd-"));
      let transportResult: CommandTransportResult;
      try {
        transportResult = await transport.run({ program, args, cwd: absCwd, timeoutMs: policy.timeoutMs, writableTempRoot: tempRoot });
      } finally {
        // The temp never becomes candidate state and is never promoted; drop it immediately.
        try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      }

      // 4. TREE AFTER — the load-bearing invariant. Any change is a HARD safety failure.
      const treeAfter = await treeProbe.treeOf(request.workspacePath);
      if (treeBefore !== treeAfter) {
        return {
          outcome: {
            kind: "command",
            program,
            args: [...args],
            cwd: rel.normalized,
            launched: transportResult.launched,
            refused: false,
            ...(transportResult.exitCode !== undefined ? { exitCode: transportResult.exitCode } : {}),
            timedOut: transportResult.timedOut,
            workspaceUnchanged: false,
            outputSha256: boundCommandOutput(transportResult.output, policy.maxOutputBytes).sha256,
            outputByteLength: Buffer.byteLength(transportResult.output, "utf8"),
            outputTruncated: false,
            untrusted: "the command changed the candidate tree — this is a safety violation and the build is stopped",
          },
          safetyFailure: commandWorkspaceMutatedFailure({ program, treeBefore, treeAfter }),
        };
      }

      // 5. RECORD — a clean, read-only result.
      const bounded = boundCommandOutput(transportResult.output, policy.maxOutputBytes);
      const sandboxMode: CommandSandboxMode = classifyCommandRisk(program, args).risky ? "sandboxed_read_only" : "unsandboxed_read_only";
      const record = buildCommandRecord({
        runId: request.runId,
        ordinal: request.ordinal,
        policyId: policy.policyId,
        program,
        args,
        cwd: rel.normalized,
        workspaceAccess: policy.workspaceAccess,
        network: policy.network,
        sandboxMode,
        launched: transportResult.launched,
        ...(transportResult.exitCode !== undefined ? { exitCode: transportResult.exitCode } : {}),
        timedOut: transportResult.timedOut,
        timeoutMs: policy.timeoutMs,
        durationMs: transportResult.durationMs,
        output: bounded,
        treeBefore,
        treeAfter,
      });
      const outcome = transportResult.launched
        ? commandLaunchedOutcome(record)
        : commandRefusalOutcome({ program, args, cwd: rel.normalized, code: "governed_exec_denied", detail: transportResult.refusedReason ?? "governed-exec denied the command" });
      return { outcome, command: record };
    },
  };
}
