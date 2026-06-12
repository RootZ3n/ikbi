/**
 * ikbi governed-exec — the executor (fail-closed, gate-wall-enforced).
 *
 * `run(request)` gates EVERY command through the shared enforcement layer before any
 * execution:
 *   1. config disabled        → deny (no exec);
 *   2. parent not validated   → deny (no exec, #10 anti-spoof);
 *   3. binary not allowlisted → deny at the module (default-deny — no gate call);
 *   4. derive the caller's autonomy grant;
 *   5. gate-wall.evaluate({ action: { kind:"exec", ..., sudo } }) — SUDO IS ALWAYS
 *      gated; deny on `allow === false`;
 *   6. dryRun → report intent + the gate decision, execute NOTHING;
 *   7. execFile(binary, argsArray) — ARRAY ARGS, NO SHELL (structural injection
 *      prevention; metacharacters are literal array elements, never interpreted);
 *   8. receipt the outcome (kind "exec") attributed to the identity.
 *
 * `fetch(request)` performs governed HTTP through the EGRESS GUARD (scheme/allowlist/
 * internal-IP rejection) — it does NOT shell out to `curl`. An SSRF block is surfaced
 * (denied), never swallowed. Receipts kind "network".
 *
 * Full args / URLs / bodies are NEVER logged — receipts/events carry the binary +
 * arg COUNT + sudo + host/method + outcome only.
 */

import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { promisify } from "node:util";

import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import { isValidatedIdentity } from "../../core/identity/index.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { ReceiptInput } from "../../core/receipt/contract.js";
import { asTier, autonomyForTier, TRUST_FLOOR } from "../../core/trust/index.js";
import type { FetchLike } from "../../core/provider/providers/openai-compatible.js";
import { resolveFetchGuard } from "../../core/provider/fetch-guard.js";
import { gateWall as coreGateWall, type GateWall } from "../gate-wall/index.js";
import { governedExecConfig, OUTPUT_TAIL_CHARS, type GovernedExecConfig } from "./config.js";
import {
  govexecDenied,
  govexecExecuted,
  govexecFailed,
  govexecRequested,
  type GovExecEventPayload,
} from "./events.js";
import type { ExecRequest, ExecResult, GovernedExec, HttpRequest, HttpResult } from "./contract.js";
import { commandPolicyDenyReason } from "./policy.js";

const EVENT_SOURCE = "governed-exec";
const EXEC_OPERATION = "govexec.run";
const FETCH_OPERATION = "govexec.fetch";

/** The exec primitive (array args, no shell). Tests substitute this. */
export type ExecFileFn = (
  binary: string,
  args: readonly string[],
  opts: { cwd?: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const promisifiedExecFile = promisify(nodeExecFile);
const defaultExecFile: ExecFileFn = (binary, args, opts) =>
  promisifiedExecFile(binary, args as string[], opts);

/**
 * The STREAMING exec primitive (SG-1): spawns the command and forwards each stdout/stderr
 * chunk to `onOutput` as it arrives, while accumulating bounded output for the tail. Resolves
 * with the captured output + exit code (it does NOT throw on a non-zero exit — the caller maps
 * the code). Tests substitute this.
 */
export type ExecFileStreamFn = (
  binary: string,
  args: readonly string[],
  opts: { cwd?: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
  onOutput: (chunk: string, stream: "stdout" | "stderr") => void,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Default streaming impl over node `spawn` (array args, no shell). Bounds capture at maxBuffer. */
const defaultExecFileStream: ExecFileStreamFn = (binary, args, opts, onOutput) =>
  new Promise((resolveP) => {
    const child = nodeSpawn(binary, args as string[], { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), env: opts.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeout);
    const onData = (which: "stdout" | "stderr") => (d: Buffer | string) => {
      const s = typeof d === "string" ? d : d.toString("utf8");
      onOutput(s, which); // LIVE — every chunk, untruncated, as it arrives
      if (which === "stdout") {
        if (stdout.length < opts.maxBuffer) stdout += s;
      } else if (stderr.length < opts.maxBuffer) stderr += s;
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr: `${stderr}${e instanceof Error ? e.message : String(e)}`, code: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, code: timedOut ? 124 : code ?? 1 });
    });
  });

/** Injectable dependencies (tests substitute gateWall / guardedFetch / receipts / execFile / clock). */
export interface GovernedExecDeps {
  readonly config?: GovernedExecConfig;
  /** Governance evaluator (the shared enforcement layer). Default: live gate-wall. */
  readonly gateWall?: GateWall;
  /** Guarded fetch (SSRF floor). Default: lazily resolved from the registered egress guard. */
  readonly guardedFetch?: FetchLike;
  readonly receipts?: { append: (input: ReceiptInput, identity: AgentIdentity) => Promise<unknown> };
  readonly publish?: (input: EventInput<GovExecEventPayload>) => void;
  /** The exec primitive. Default: promisified node execFile (array args, no shell). */
  readonly execFile?: ExecFileFn;
  /** The STREAMING exec primitive (used when a request sets `onOutput`). Default: node spawn. */
  readonly execFileStream?: ExecFileStreamFn;
}

/** Last `OUTPUT_TAIL_CHARS` of a captured stream (bounded; never the full body). */
function tail(s: string): string {
  return s.length > OUTPUT_TAIL_CHARS ? s.slice(-OUTPUT_TAIL_CHARS) : s;
}

/** Host of a URL for the audit (never the full URL — query may carry secrets). */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG"] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const extra = process.env.IKBI_GOVERNED_EXEC_ENV_ALLOWLIST;
  if (extra !== undefined) {
    for (const raw of extra.split(",")) {
      const key = raw.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  return env;
}

function forbiddenEvalReason(command: string, args: readonly string[]): string | undefined {
  if (command === "node" && args.some((a) => a === "-e" || a === "--eval" || a === "-p" || a === "--print")) {
    return "node code-eval flags are not allowed by governed-exec";
  }
  if ((command === "npm" || command === "pnpm") && args.some((a) => a === "--eval" || a === "-e")) {
    return `${command} code-eval flags are not allowed by governed-exec`;
  }
  return undefined;
}

/** Build a governed executor. The default deps wire the live frozen singletons + gate-wall + egress. */
export function createGovernedExec(deps: GovernedExecDeps = {}): GovernedExec {
  const config = deps.config ?? governedExecConfig;
  const gateWall = deps.gateWall ?? coreGateWall;
  const receipts = deps.receipts ?? coreReceipts;
  const publish = deps.publish ?? ((input: EventInput<GovExecEventPayload>) => void coreEvents.publish(input));
  const execFile = deps.execFile ?? defaultExecFile;
  const execFileStream = deps.execFileStream ?? defaultExecFileStream;
  const allowlist = new Set(config.allowlist);
  // Lazy: resolving the egress guard at construction would throw if egress is not yet
  // registered. Resolve per-call so importing this module never forces that ordering.
  const guardedFetch: FetchLike = deps.guardedFetch ?? ((input, init) => resolveFetchGuard()(input, init));

  function emit(
    event: { create: (p: GovExecEventPayload, o?: { source?: string; attribution?: { identity?: AgentIdentity; operation?: string; runId?: string } }) => EventInput<GovExecEventPayload> },
    payload: GovExecEventPayload,
    identity: AgentIdentity | undefined,
    operation: string,
    runId: string | undefined,
  ): void {
    publish(
      event.create(payload, {
        source: EVENT_SOURCE,
        attribution: { ...(identity !== undefined ? { identity } : {}), operation, ...(runId !== undefined ? { runId } : {}) },
      }),
    );
  }

  /** Write a receipt only when we have a validated identity to attribute it to. */
  async function receipt(
    operation: string,
    identity: AgentIdentity | undefined,
    outcome: ReceiptInput["outcome"],
    metadata: Record<string, unknown>,
    requestId: string | undefined,
    project: string | undefined,
  ): Promise<void> {
    if (identity === undefined) return;
    await receipts.append(
      {
        operation,
        outcome,
        metadata,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(project !== undefined ? { project } : {}),
      },
      identity,
    );
  }

  async function run(request: ExecRequest): Promise<ExecResult> {
    const { parentCtx, command, args, cwd } = request;
    const sudo = request.sudo ?? false;
    const argCount = args.length;
    const identity = isValidatedIdentity(parentCtx.identity) ? parentCtx.identity.identity : undefined;
    const requestId = parentCtx.requestId;
    const base: GovExecEventPayload = { kind: "exec", command, argCount, sudo };

    emit(govexecRequested, base, identity, EXEC_OPERATION, requestId);

    const deny = async (reason: string, allow?: boolean): Promise<ExecResult> => {
      emit(govexecDenied, { ...base, reason, ...(allow !== undefined ? { allow } : {}) }, identity, EXEC_OPERATION, requestId);
      await receipt(
        EXEC_OPERATION,
        identity,
        { status: "rejected", error: reason },
        { action: "exec", command, argCount, sudo, ...(allow !== undefined ? { allow } : {}) },
        requestId,
        cwd,
      );
      return { executed: false, denied: true, reason };
    };

    // (1) disabled ⇒ deny fail-closed (never bypass to run ungoverned).
    if (!config.enabled) return deny("governed-exec disabled");
    // (2) the parent MUST carry a genuinely-minted ValidatedIdentity (#10 anti-spoof).
    if (identity === undefined) return deny("parent identity is not a validated identity");
    // (3) DEFAULT-DENY ALLOWLIST: an un-allowlisted binary never runs (no gate call).
    if (!allowlist.has(command)) return deny(`binary "${command}" is not on the allowlist`);
    const evalDeny = forbiddenEvalReason(command, args);
    if (evalDeny !== undefined) return deny(evalDeny);
    const policyDeny = commandPolicyDenyReason(command, args, request.purpose);
    if (policyDeny !== undefined) return deny(policyDeny);

    // (4) the caller's grant. (5) GATE-WALL — sudo is part of the gated action.
    const grant = autonomyForTier(asTier(identity.trustTier ?? TRUST_FLOOR, TRUST_FLOOR));
    const governance = await gateWall.evaluate({
      grant,
      action: { kind: "exec", command, args, sudo, ...(request.purpose !== undefined ? { purpose: request.purpose } : {}) },
      identity,
    });
    if (!governance.allow) return deny(governance.reason ?? "gate-wall denied the command", false);

    // (6) dryRun ⇒ report intent + the allow decision; execute NOTHING.
    if (parentCtx.dryRun === true) {
      const reason = `dry-run: would exec ${sudo ? "sudo " : ""}${command} (${argCount} args)`;
      emit(govexecExecuted, { ...base, allow: true, dryRun: true, reason }, identity, EXEC_OPERATION, requestId);
      await receipt(
        EXEC_OPERATION,
        identity,
        { status: "success", detail: reason },
        { action: "exec", command, argCount, sudo, allow: true, dryRun: true },
        requestId,
        cwd,
      );
      return { executed: false, reason };
    }

    // (7) EXECUTE — array args, NO shell. (8) receipt the outcome.
    // Per-call timeout override (verification checks pass a larger IKBI_CHECK_TIMEOUT_MS); absent /
    // non-positive ⇒ the module default (unchanged).
    const effectiveTimeout = typeof request.timeoutMs === "number" && request.timeoutMs > 0 ? request.timeoutMs : config.execTimeoutMs;
    // STREAMING path (SG-1): when the caller wants live output, spawn and forward each chunk.
    // The receipt/result still carry only the BOUNDED tail — truncation is for the record, not
    // the live view. A non-zero exit is reported, never thrown.
    if (request.onOutput !== undefined) {
      const { stdout, stderr, code } = await execFileStream(
        command,
        args,
        { ...(cwd !== undefined ? { cwd } : {}), timeout: effectiveTimeout, maxBuffer: config.maxBuffer, env: scrubbedEnv() },
        request.onOutput,
      );
      if (code === 0) {
        emit(govexecExecuted, { ...base, allow: true, exitCode: 0 }, identity, EXEC_OPERATION, requestId);
        await receipt(EXEC_OPERATION, identity, { status: "success", detail: `exec ${command} ok` }, { action: "exec", command, argCount, sudo, allow: true, exitCode: 0 }, requestId, cwd);
        return { executed: true, exitCode: 0, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
      }
      const reason = `command exited ${code}`;
      emit(govexecFailed, { ...base, allow: true, exitCode: code, reason }, identity, EXEC_OPERATION, requestId);
      await receipt(EXEC_OPERATION, identity, { status: "failure", error: reason, code: String(code) }, { action: "exec", command, argCount, sudo, allow: true, exitCode: code }, requestId, cwd);
      return { executed: true, exitCode: code, reason, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
    }
    try {
      const { stdout, stderr } = await execFile(command, args, {
        ...(cwd !== undefined ? { cwd } : {}),
        timeout: effectiveTimeout,
        maxBuffer: config.maxBuffer,
        env: scrubbedEnv(),
      });
      emit(govexecExecuted, { ...base, allow: true, exitCode: 0 }, identity, EXEC_OPERATION, requestId);
      await receipt(
        EXEC_OPERATION,
        identity,
        { status: "success", detail: `exec ${command} ok` },
        { action: "exec", command, argCount, sudo, allow: true, exitCode: 0 },
        requestId,
        cwd,
      );
      return { executed: true, exitCode: 0, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      const exitCode = typeof e.code === "number" ? e.code : 1;
      const reason = `command exited ${exitCode}`;
      emit(govexecFailed, { ...base, allow: true, exitCode, reason }, identity, EXEC_OPERATION, requestId);
      await receipt(
        EXEC_OPERATION,
        identity,
        { status: "failure", error: reason, code: String(exitCode) },
        { action: "exec", command, argCount, sudo, allow: true, exitCode },
        requestId,
        cwd,
      );
      return {
        executed: true,
        exitCode,
        reason,
        stdoutTail: tail(e.stdout ?? ""),
        stderrTail: tail(e.stderr ?? ""),
      };
    }
  }

  async function fetch(request: HttpRequest): Promise<HttpResult> {
    const { parentCtx, url, method } = request;
    const host = safeHost(url);
    const identity = isValidatedIdentity(parentCtx.identity) ? parentCtx.identity.identity : undefined;
    const requestId = parentCtx.requestId;
    const base: GovExecEventPayload = { kind: "network", command: method };

    emit(govexecRequested, base, identity, FETCH_OPERATION, requestId);

    const deny = async (reason: string): Promise<HttpResult> => {
      emit(govexecDenied, { ...base, reason }, identity, FETCH_OPERATION, requestId);
      await receipt(FETCH_OPERATION, identity, { status: "rejected", error: reason }, { action: "network", method, host }, requestId, undefined);
      return { executed: false, denied: true, reason };
    };

    // (1) disabled ⇒ deny. (2) parent must be validated.
    if (!config.enabled) return deny("governed-exec disabled");
    if (identity === undefined) return deny("parent identity is not a validated identity");

    // (6) dryRun ⇒ report intent, perform NO network call.
    if (parentCtx.dryRun === true) {
      const reason = `dry-run: would ${method} ${host}`;
      emit(govexecExecuted, { ...base, dryRun: true, reason }, identity, FETCH_OPERATION, requestId);
      await receipt(FETCH_OPERATION, identity, { status: "success", detail: reason }, { action: "network", method, host, dryRun: true }, requestId, undefined);
      return { executed: false, reason };
    }

    // (7) EGRESS-GUARDED HTTP — the guard enforces scheme/allowlist/internal-IP. A
    // block is SURFACED (denied), never swallowed.
    try {
      const res = await guardedFetch(url, {
        method,
        headers: request.headers !== undefined ? { ...request.headers } : {},
        body: request.body ?? "",
        signal: AbortSignal.timeout(config.networkTimeoutMs),
      });
      const body = await res.text();
      emit(govexecExecuted, { ...base, status: res.status }, identity, FETCH_OPERATION, requestId);
      await receipt(
        FETCH_OPERATION,
        identity,
        { status: res.ok ? "success" : "failure", detail: `${method} ${host} → ${res.status}` },
        { action: "network", method, host, status: res.status },
        requestId,
        undefined,
      );
      return { executed: true, status: res.status, bodyTail: tail(body) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      emit(govexecFailed, { ...base, reason }, identity, FETCH_OPERATION, requestId);
      await receipt(FETCH_OPERATION, identity, { status: "failure", error: reason }, { action: "network", method, host }, requestId, undefined);
      // Surfaced as denied (the egress guard refused, or the call failed) — not swallowed.
      return { executed: false, denied: true, reason };
    }
  }

  return { run, fetch };
}

/** The default process-wide governed executor, wired to the live singletons + gate-wall + egress. */
export const governedExec: GovernedExec = createGovernedExec();
