/**
 * ikbi LSP module — public API.
 *
 * `runLspDiagnostics(deps, opts)` detects the project's languages (cached per directory) and runs
 * each language's diagnostic engine through GOVERNED-EXEC — the same allowlisted, gate-walled,
 * receipted path the verifier's checks use. It NEVER spawns a raw process: a binary that is not on
 * the allowlist comes back denied and is reported as such, not run. Fail-closed: without a parent
 * identity nothing runs (governed-exec cannot be authorized).
 *
 * The diagnostic drivers are the engines the language servers themselves wrap:
 *   typescript → npx tsc --noEmit --pretty false
 *   python     → npx pyright --outputjson
 *   go         → go vet ./...
 *   rust       → cargo check --message-format=json --quiet
 *
 * TRUST: the formatted report is derived from compiler output (file paths + messages) — UNTRUSTED.
 * The caller re-neutralizes it at its own chokepoint before it re-enters the model (like terminal).
 */

import type { OperationContext } from "../../core/identity/index.js";
import type { ExecResult, GovernedExec } from "../governed-exec/index.js";
import type { DetectedLanguage, LspDiagnostic, LspDiagnosticReport, LspLanguage, LspRunResult } from "./contract.js";
import { detectLanguages } from "./detect.js";
import { parseCargo, parseGoVet, parsePyright, parseTsc } from "./parsers.js";

export type { LspDiagnostic, LspDiagnosticReport, LspLanguage, LspRunResult, DetectedLanguage } from "./contract.js";
export { detectLanguages, clearDetectionCache, detectionCacheSize } from "./detect.js";
export { parseTsc, parsePyright, parseGoVet, parseCargo } from "./parsers.js";

/** What the diagnostic runner needs: the governed executor + the run's identity. */
export interface LspDeps {
  readonly governedExec: Pick<GovernedExec, "run">;
  /** The run's validated identity — authorizes governed-exec. Absent ⇒ fails closed. */
  readonly parentCtx?: OperationContext;
}

/** Options for a diagnostic run. */
export interface LspRunOptions {
  /** Absolute project root (the worktree). */
  readonly rootDir: string;
  /** Restrict to ONE language instead of every detected one. */
  readonly language?: LspLanguage;
}

/** Per-language diagnostic driver: the binary, its args, and which parser reads stdout/stderr. */
interface Driver {
  readonly command: string;
  readonly args: readonly string[];
  /** Which stream the diagnostics land on. */
  readonly stream: "stdout" | "stderr" | "both";
  readonly parse: (output: string) => LspDiagnostic[];
}

const DRIVERS: Readonly<Record<LspLanguage, Driver>> = {
  typescript: { command: "npx", args: ["tsc", "--noEmit", "--pretty", "false"], stream: "stdout", parse: parseTsc },
  python: { command: "npx", args: ["pyright", "--outputjson"], stream: "stdout", parse: parsePyright },
  go: { command: "go", args: ["vet", "./..."], stream: "stderr", parse: parseGoVet },
  rust: { command: "cargo", args: ["check", "--message-format=json", "--quiet"], stream: "stdout", parse: parseCargo },
};

/** A generous timeout: a cold typecheck/cargo-check can take a while. */
const LSP_TIMEOUT_MS = 180_000;

/** Run diagnostics for the detected (or requested) languages and return a structured report. */
export async function runLspDiagnostics(deps: LspDeps, opts: LspRunOptions): Promise<LspDiagnosticReport> {
  const detected = detectLanguages(opts.rootDir);
  const target: readonly DetectedLanguage[] =
    opts.language !== undefined ? detected.filter((d) => d.language === opts.language) : detected;

  // A forced language that was not detected: still attempt it (the operator asked explicitly),
  // synthesizing a marker so the report explains what ran.
  const toRun: readonly DetectedLanguage[] =
    opts.language !== undefined && target.length === 0
      ? [{ language: opts.language, marker: "(requested)" }]
      : target;

  const results: LspRunResult[] = [];
  for (const det of toRun) {
    results.push(await runOne(deps, opts.rootDir, det.language));
  }
  return { detected, results };
}

/** Run one language's diagnostic engine and parse the result. */
async function runOne(deps: LspDeps, rootDir: string, language: LspLanguage): Promise<LspRunResult> {
  const driver = DRIVERS[language];
  const commandLine = `${driver.command} ${driver.args.join(" ")}`;
  if (deps.parentCtx === undefined) {
    return { language, command: commandLine, ran: false, diagnostics: [], note: "no parent identity wired to authorize governed-exec" };
  }
  let res: ExecResult;
  try {
    res = await deps.governedExec.run({
      parentCtx: deps.parentCtx,
      command: driver.command,
      args: [...driver.args],
      cwd: rootDir,
      purpose: `lsp_diagnostic: ${language}`,
      timeoutMs: LSP_TIMEOUT_MS,
    });
  } catch (e) {
    return { language, command: commandLine, ran: false, diagnostics: [], note: `diagnostic command failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.denied === true) {
    return { language, command: commandLine, ran: false, diagnostics: [], note: `denied by governed-exec: ${res.reason ?? "binary not allowlisted"}` };
  }
  if (res.executed !== true) {
    return { language, command: commandLine, ran: false, diagnostics: [], note: res.reason ?? "command did not execute (tool missing?)" };
  }
  const stdout = res.stdoutTail ?? "";
  const stderr = res.stderrTail ?? "";
  const output = driver.stream === "stdout" ? stdout : driver.stream === "stderr" ? stderr : `${stdout}\n${stderr}`;
  // Many diagnostic tools also write to the other stream; parse both defensively.
  const diagnostics = dedupe([...driver.parse(output), ...driver.parse(driver.stream === "stdout" ? stderr : stdout)]);
  return { language, command: commandLine, ran: true, diagnostics };
}

/** Drop duplicate diagnostics (same file/line/col/message) that double-stream parsing can produce. */
function dedupe(diags: readonly LspDiagnostic[]): LspDiagnostic[] {
  const seen = new Set<string>();
  const out: LspDiagnostic[] = [];
  for (const d of diags) {
    const key = `${d.file}:${d.line}:${d.column}:${d.severity}:${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** Total error/warning counts across a report. */
export function countDiagnostics(report: LspDiagnosticReport): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const r of report.results) {
    for (const d of r.diagnostics) {
      if (d.severity === "error") errors += 1;
      else if (d.severity === "warning") warnings += 1;
    }
  }
  return { errors, warnings };
}

/** Render a report into a compact, model-readable string (the tool's output payload). */
export function formatLspReport(report: LspDiagnosticReport): string {
  if (report.detected.length === 0 && report.results.length === 0) {
    return "LSP: no supported project type detected (looked for tsconfig.json, pyproject.toml, go.mod, Cargo.toml). Nothing to check.";
  }
  const lines: string[] = [];
  const detList = report.detected.map((d) => `${d.language} (${d.marker})`).join(", ");
  lines.push(`LSP diagnostics — detected: ${detList || "none"}`);
  const { errors, warnings } = countDiagnostics(report);
  lines.push(`Summary: ${errors} error(s), ${warnings} warning(s).`);
  for (const r of report.results) {
    lines.push("---");
    if (!r.ran) {
      lines.push(`[${r.language}] ${r.command} — NOT RUN: ${r.note ?? "unavailable"}`);
      continue;
    }
    if (r.diagnostics.length === 0) {
      lines.push(`[${r.language}] ${r.command} — CLEAN (no diagnostics).`);
      continue;
    }
    lines.push(`[${r.language}] ${r.command} — ${r.diagnostics.length} diagnostic(s):`);
    for (const d of r.diagnostics.slice(0, 100)) {
      const pos = d.line > 0 ? `:${d.line}${d.column > 0 ? `:${d.column}` : ""}` : "";
      const code = d.code !== undefined ? ` [${d.code}]` : "";
      lines.push(`  ${d.file}${pos} ${d.severity}${code}: ${d.message}`);
    }
    if (r.diagnostics.length > 100) lines.push(`  … and ${r.diagnostics.length - 100} more.`);
  }
  return lines.join("\n");
}
