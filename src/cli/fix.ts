/**
 * ikbi — the `ikbi fix <repo>` CLI command (docs/FIX-MODE-DESIGN.md §4).
 *
 *   ikbi fix <repo> [--check "<cmd>"] [--allow-test-edits] [--allow-config-edits]
 *                   [--diagnose-only] [--max-files N] [--json]
 *
 * Diagnosis-first repair: reproduce the failure, classify it, and either repair narrowly or
 * REFUSE (a correct refusal is a success, not a failure). NEVER promotes — the fix lands in the
 * target tree's files but is never committed/merged without explicit approval (a future flag).
 *
 * Fail-closed + friendly: a missing operator token prints an actionable message and exits
 * non-zero BEFORE any run. The check runs through GOVERNED-EXEC (allowlist + gate-wall +
 * receipts) — a non-allowlisted check binary (e.g. `python3`) is DENIED (fail-closed), which the
 * pipeline surfaces honestly rather than as a vacuous pass. The model runs through the SAME
 * provider/invoke build mode uses.
 */

import { registerCommand } from "./registry.js";
import { writeStderr, writeStdout } from "./io.js";
import { config } from "../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../core/identity/index.js";
import type { OperationContext, ValidatedIdentity } from "../core/identity/index.js";
import { resolveCheckTimeoutMs } from "../modules/worker-model/checks.js";
import { runFixPipeline, type CheckRun, type FixCheckCommand, type FixOptions, type FixOutcome } from "../modules/worker-model/fix.js";
import type { FixReceipt } from "../modules/worker-model/fix-receipt.js";
import type { ExecRequest, ExecResult } from "../modules/governed-exec/index.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parsed `ikbi fix` arguments. */
export interface FixArgs {
  readonly repo?: string;
  readonly check?: FixCheckCommand;
  readonly allowTestEdits: boolean;
  readonly allowConfigEdits: boolean;
  readonly diagnoseOnly: boolean;
  readonly maxFiles?: number;
  readonly json: boolean;
}

/** Parse `ikbi fix <repo>` args. The first non-flag token is the repo path. */
export function parseFixArgs(argv: readonly string[]): FixArgs {
  let repo: string | undefined;
  let check: FixCheckCommand | undefined;
  let allowTestEdits = false;
  let allowConfigEdits = false;
  let diagnoseOnly = false;
  let maxFiles: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--check") {
      check = splitCheck(argv[i + 1]);
      i += 1;
    } else if (a.startsWith("--check=")) {
      check = splitCheck(a.slice("--check=".length));
    } else if (a === "--allow-test-edits") {
      allowTestEdits = true;
    } else if (a === "--allow-config-edits") {
      allowConfigEdits = true;
    } else if (a === "--diagnose-only") {
      diagnoseOnly = true;
    } else if (a === "--max-files") {
      const n = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) maxFiles = n;
      i += 1;
    } else if (a.startsWith("--max-files=")) {
      const n = Number.parseInt(a.slice("--max-files=".length), 10);
      if (Number.isFinite(n) && n > 0) maxFiles = n;
    } else if (a === "--json") {
      json = true;
    } else if (!a.startsWith("-") && repo === undefined) {
      repo = a;
    }
  }
  return { ...(repo !== undefined ? { repo } : {}), ...(check !== undefined ? { check } : {}), allowTestEdits, allowConfigEdits, diagnoseOnly, ...(maxFiles !== undefined ? { maxFiles } : {}), json };
}

/** Split a `--check "<cmd> <args...>"` string into a command + args (whitespace-tokenized). */
export function splitCheck(raw: string | undefined): FixCheckCommand | undefined {
  if (raw === undefined) return undefined;
  const toks = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  if (toks.length === 0) return undefined;
  return { command: toks[0]!, args: toks.slice(1) };
}

/** Human-readable result legend (a refusal is a SUCCESS). */
const RESULT_NOTE: Record<string, string> = {
  FIXED_NARROWLY: "diagnosis correct, minimal patch applied, checks pass, anti-cheat clean",
  CORRECT_REFUSAL: "the right answer was 'I should not edit code here' — refused (success)",
  SAFE_FAIL: "tried, could not fix, but did not cheat (no changes promoted)",
  UNSAFE_FAIL: "ANTI-CHEAT VIOLATION — the fix tried to cheat; halted, nothing promoted",
  NEEDS_HUMAN: "diagnosis or risk requires human judgment",
  TOOL_LIMITATION: "the verifier could not run/parse the tests — not a project failure",
  ENVIRONMENT_MISSING: "a required tool/verifier is not installed",
  UNRESOLVED: "could not determine the root cause",
};

/** Render a fix receipt as operator-readable lines. */
export function formatFixReceipt(o: FixOutcome): string {
  const r: FixReceipt = o.receipt;
  const lines: string[] = [];
  lines.push(`fix ${r.result} — ${RESULT_NOTE[r.result] ?? ""}`);
  lines.push("");
  lines.push(`  repo:        ${r.started.repo}`);
  lines.push(`  check:       ${r.started.check}`);
  lines.push(`  head:        ${r.started.head}`);
  lines.push(`  reproduced:  exit ${r.failureReproduced.exitCode} — ${r.failureReproduced.outcomes.summary}`);
  lines.push(`  diagnosis:   ${r.diagnosis.category} (confidence ${r.diagnosis.confidence.toFixed(2)})`);
  lines.push(`               ${r.diagnosis.evidence}`);
  if (r.diagnosis.affectedFiles.length > 0) lines.push(`  affected:    ${r.diagnosis.affectedFiles.join(", ")}`);
  if (o.filesModified.length > 0) {
    lines.push(`  patched:     ${o.filesModified.join(", ")}`);
    lines.push(`  targeted:    ${r.targetedCheck.passed ? "PASS" : "FAIL"}`);
    lines.push(`  full check:  ${r.fullCheck.passed ? "PASS" : "FAIL"} (${r.fullCheck.regressionCount} regression(s))`);
  } else {
    lines.push(`  patched:     (no files changed)`);
  }
  lines.push(`  anti-cheat:  ${r.antiCheat.passed ? "PASS" : "FAIL"}`);
  for (const c of r.antiCheat.checks) lines.push(`     ${c.passed ? "✓" : "✗"} ${c.name}: ${c.evidence}`);
  lines.push(`  promoted:    ${r.promoted ? "yes" : "no (fix mode never promotes without approval)"}`);
  return `${lines.join("\n")}\n`;
}

/** Injectable surfaces so the CLI is testable without a live model / subprocess. */
export interface FixCliDeps {
  readonly resolveIdentity?: (claim: { token: string }) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  /** Governed executor the check runs through. Default: the live singleton (lazy). */
  readonly governedExec?: { run: (req: ExecRequest) => Promise<ExecResult> };
  /** Run the pipeline. Default: the real `runFixPipeline`. Injectable for tests. */
  readonly runPipeline?: (opts: FixOptions, deps: { runCheck: (repo: string, check: FixCheckCommand) => Promise<CheckRun> }) => Promise<FixOutcome>;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly cwd?: () => string;
}

/** Map a governed ExecResult into the pipeline's CheckRun shape (a denial is a non-zero, honest output). */
function execToCheckRun(res: ExecResult): CheckRun {
  const output = `${res.stdoutTail ?? ""}${res.stderrTail ?? ""}`;
  if (res.denied === true) {
    return { exitCode: 126, output: `GOVERNED-EXEC DENIED: ${res.reason ?? "command refused (allowlist/gate)"}\n${output}` };
  }
  if (!res.executed) {
    return { exitCode: 1, output: `check did not execute: ${res.reason ?? "unknown"}\n${output}` };
  }
  return { exitCode: res.exitCode ?? 0, output };
}

/** Build the `ikbi fix` handler. Defaults wire the live singletons. */
export function createFixCli(deps: FixCliDeps = {}) {
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const cwd = deps.cwd ?? (() => process.cwd());
  const governedExec = deps.governedExec ?? { run: async (req: ExecRequest) => (await import("../modules/governed-exec/index.js")).governedExec.run(req) };
  const runPipeline = deps.runPipeline ?? runFixPipeline;

  async function fix(argv: readonly string[]): Promise<void> {
    if (argv[0] === "--help" || argv[0] === "-h") {
      out(
        "Usage: ikbi fix <repo> [--check \"<cmd>\"] [options]\n\n" +
          "Diagnose a failing check and repair it narrowly — or correctly refuse.\n\n" +
          "Options:\n" +
          "  --check \"<cmd>\"       The failing check to reproduce (default: python3 -m pytest -q)\n" +
          "  --allow-test-edits    Permit editing test files (default: off — tests are ground truth)\n" +
          "  --allow-config-edits  Permit editing test-discovery config files (default: off)\n" +
          "  --diagnose-only       Stages 1-4 only (classify, no edits)\n" +
          "  --max-files N         Cap files the fix may modify (default 5)\n" +
          "  --json                Emit the fix receipt as JSON\n",
      );
      return;
    }

    const args = parseFixArgs(argv);
    const repo = args.repo ?? cwd();

    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return;
    }

    let who: ValidatedIdentity;
    try {
      who = resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi: operator identity resolution failed: ${errMsg(e)} — check IKBI_OPERATOR_TOKEN\n`);
      setExit(1);
      return;
    }
    const ctx: OperationContext = beginOperation(who, { requestId: `fix-${Date.now()}` });
    const checkTimeoutMs = resolveCheckTimeoutMs();

    // The check runs through governed-exec (allowlist + gate-wall + receipts) under the operator ctx.
    const runCheck = async (repoPath: string, check: FixCheckCommand): Promise<CheckRun> => {
      const res = await governedExec.run({ parentCtx: ctx, command: check.command, args: [...check.args], cwd: repoPath, purpose: `fix check: ${check.command} ${check.args.join(" ")}`.trim(), timeoutMs: checkTimeoutMs });
      return execToCheckRun(res);
    };

    const opts: FixOptions = {
      repo,
      ...(args.check !== undefined ? { check: args.check } : {}),
      allowTestEdits: args.allowTestEdits,
      allowConfigEdits: args.allowConfigEdits,
      diagnoseOnly: args.diagnoseOnly,
      ...(args.maxFiles !== undefined ? { maxFiles: args.maxFiles } : {}),
    };

    let outcome: FixOutcome;
    try {
      outcome = await runPipeline(opts, { runCheck });
    } catch (e) {
      err(`ikbi: fix failed: ${errMsg(e)}\n`);
      setExit(1);
      return;
    }

    if (args.json) {
      out(`${JSON.stringify(outcome.receipt, null, 2)}\n`);
    } else {
      out(formatFixReceipt(outcome));
    }

    // A correct refusal / fixed-narrowly is a SUCCESS (exit 0). Unsafe/unresolved/safe-fail are non-zero.
    const failed = outcome.result === "UNSAFE_FAIL" || outcome.result === "UNRESOLVED" || outcome.result === "SAFE_FAIL" || outcome.result === "NEEDS_HUMAN";
    if (failed) setExit(1);
  }

  return { fix };
}

// Register the LIVE command at import time (imported by cli/index.js).
const live = createFixCli();
registerCommand({
  name: "fix",
  summary: "Diagnose a failing check and repair it narrowly (or correctly refuse) — never promotes",
  usage: "ikbi fix <repo> [--check \"<cmd>\"] [--allow-test-edits] [--diagnose-only] [--max-files N] [--json]",
  run: (argv) => live.fix(argv),
});
