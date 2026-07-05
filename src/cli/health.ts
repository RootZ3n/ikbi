/**
 * ikbi `health` — repo health across 6 scored dimensions (file / dependency / test /
 * doc / import / structure). Backed by the repo-doctor module — the same analyzers the
 * HTTP surface (`GET /ikbi/repo-doctor/health`) serves, now with a first-class CLI so an
 * operator can invoke the capability naturally instead of only over the wire.
 *
 *   ikbi health                       score the repo in the current directory
 *   ikbi health --repo <dir>          score a different repo root
 *   ikbi health --dimension test-health   run a single dimension
 *   ikbi health --json                machine-readable report (for CI / tooling)
 *
 * Read-only, offline, no provider init.
 */

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { whatNextFooter } from "./what-next.js";
import {
  DIMENSIONS,
  runAllAnalyzers,
  runAnalyzer,
  type DimensionReport,
  type HealthDimension,
  type HealthReport,
} from "../modules/repo-doctor/index.js";

export interface HealthCliDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
}

const USAGE = "ikbi health [--repo <dir>] [--dimension <name>] [--json]";

function parseArgs(argv: readonly string[]): { repo: string; dimension: string | undefined; json: boolean; help: boolean } {
  let repo = process.cwd();
  let dimension: string | undefined;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--json") json = true;
    else if (a === "--repo") { if (argv[i + 1] !== undefined) repo = argv[i + 1] as string; i += 1; }
    else if (a === "--dimension") { if (argv[i + 1] !== undefined) dimension = argv[i + 1] as string; i += 1; }
  }
  return { repo, dimension, json, help };
}

/** A 0-100 score → a plain-language band + glyph (no color; terminal-safe). */
function band(score: number): string {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 50) return "fair";
  if (score >= 25) return "poor";
  return "critical";
}

const SEV_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

function renderDimension(d: DimensionReport): string {
  const lines: string[] = [];
  lines.push(`  ${d.dimension.padEnd(18)} ${String(d.score).padStart(3)}/100  ${band(d.score)}`);
  const findings = [...d.findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
  for (const f of findings) {
    const loc = f.file !== undefined ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
    lines.push(`      [${f.severity}] ${f.message}${loc}`);
    if (f.suggestion !== undefined) lines.push(`         → ${f.suggestion}`);
  }
  return lines.join("\n");
}

/** Render a full report as a human-readable block (no trailing footer). */
export function renderReport(r: HealthReport): string {
  const lines: string[] = [];
  lines.push(`Repo health: ${r.overallScore}/100 (${band(r.overallScore)})  —  ${r.repoPath}`);
  lines.push("");
  for (const d of r.dimensions) lines.push(renderDimension(d));
  return lines.join("\n");
}

export function createHealthCli(deps: HealthCliDeps = {}) {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;

  function run(argv: readonly string[]): void {
    const args = parseArgs(argv);
    if (args.help) {
      out(
        `Usage: ${USAGE}\n\n` +
          `Score a repository's health across 6 dimensions (0-100 each):\n` +
          `  ${DIMENSIONS.join(", ")}.\n` +
          `Read-only and offline — the same analyzers the HTTP repo-doctor surface serves.\n`,
      );
      return;
    }

    if (args.dimension !== undefined) {
      if (!DIMENSIONS.includes(args.dimension as HealthDimension)) {
        err(`health: unknown dimension "${args.dimension}". Valid: ${DIMENSIONS.join(", ")}\n`);
        process.exitCode = 1;
        return;
      }
      let report: DimensionReport;
      try {
        report = runAnalyzer(args.dimension as HealthDimension, args.repo);
      } catch (e) {
        err(`health: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
        return;
      }
      if (args.json) { out(`${JSON.stringify(report, null, 2)}\n`); return; }
      out(`${renderDimension(report)}\n`);
      return;
    }

    let report: HealthReport;
    try {
      report = runAllAnalyzers(args.repo);
    } catch (e) {
      err(`health: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
      return;
    }
    if (args.json) { out(`${JSON.stringify(report, null, 2)}\n`); return; }
    out(`${renderReport(report)}\n`);
    out(`${whatNextFooter("health", { issues: report.dimensions.reduce((n, d) => n + d.findings.length, 0) })}\n`);
  }

  return { run };
}

registerCommand({
  name: "health",
  summary: "Score the repo's health across 6 dimensions (file/dependency/test/doc/import/structure)",
  usage: USAGE,
  run: (argv) => createHealthCli().run(argv),
});
