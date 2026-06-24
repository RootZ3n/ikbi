/**
 * ikbi `detect` — auto-detect the current repo's language, framework, test runner, and
 * build tool from its on-disk marker files. Read-only, offline, no provider init.
 *
 *   ikbi detect              detect the project in the current directory
 *   ikbi detect --repo <dir> detect a different repo root
 *   ikbi detect --json       machine-readable result (for CI / tooling)
 */

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { detectProject, liveDetectPorts, summarize, type DetectPorts, type ProjectDetection } from "../modules/project-detection/index.js";
import { whatNextFooter } from "./what-next.js";

export interface DetectCliDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  /** Filesystem ports (default: the live synchronous fs). Injectable for tests. */
  readonly ports?: DetectPorts;
}

const USAGE = "ikbi detect [--repo <dir>] [--json]";

function parseArgs(argv: readonly string[]): { repo: string; json: boolean; help: boolean } {
  let repo = process.cwd();
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--json") json = true;
    else if (a === "--repo") { if (argv[i + 1] !== undefined) repo = argv[i + 1] as string; i += 1; }
  }
  return { repo, json, help };
}

/** Render a detection as a human-readable block (no trailing whatNext footer). */
export function renderDetection(d: ProjectDetection): string {
  const lines: string[] = [];
  lines.push(`Project: ${summarize(d)}`);
  lines.push("");
  lines.push(`  Language(s):   ${d.languages.length > 0 ? d.languages.join(", ") : "(none detected)"}`);
  lines.push(`  Framework(s):  ${d.frameworks.length > 0 ? d.frameworks.join(", ") : "(none detected)"}`);
  lines.push(`  Test runner:   ${d.testRunners.length > 0 ? d.testRunners.join(", ") : "(none detected)"}`);
  lines.push(`  Build tool:    ${d.buildTools.length > 0 ? d.buildTools.join(", ") : "(none detected)"}`);
  if (d.packageManager !== undefined) lines.push(`  Pkg manager:   ${d.packageManager}`);
  lines.push(`  Git repo:      ${d.hasGit ? "yes" : "no"}`);
  lines.push(`  Docker:        ${d.hasDocker ? "yes" : "no"}`);
  if (d.markers.length > 0) lines.push(`  Markers:       ${d.markers.join(", ")}`);
  return lines.join("\n");
}

export function createDetectCli(deps: DetectCliDeps = {}) {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const ports = deps.ports ?? liveDetectPorts();

  function run(argv: readonly string[]): void {
    const args = parseArgs(argv);
    if (args.help) {
      out(`Usage: ${USAGE}\n\nAuto-detect the project's language, framework, test runner, and build tool\nfrom its marker files (package.json, pyproject.toml, go.mod, Cargo.toml, …).\nRead-only and offline.\n`);
      return;
    }
    let d: ProjectDetection;
    try {
      d = detectProject(args.repo, ports);
    } catch (e) {
      err(`detect: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
      return;
    }
    if (args.json) {
      out(`${JSON.stringify(d, null, 2)}\n`);
      return;
    }
    out(`${renderDetection(d)}\n`);
    out(`${whatNextFooter("detect")}\n`);
  }

  return { run };
}

registerCommand({
  name: "detect",
  summary: "Auto-detect the project's language, framework, test runner, and build tool",
  usage: USAGE,
  run: (argv) => createDetectCli().run(argv),
});
