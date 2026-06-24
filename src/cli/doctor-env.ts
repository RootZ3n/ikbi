/**
 * ikbi `doctor` — ENVIRONMENT checks (the host/toolchain half).
 *
 * `doctor.ts`'s `runDoctor` reports CONFIG health (tokens, role models, posture). This module
 * is its sibling for the ENVIRONMENT: Node version, package manager, git, disk space, the
 * `.ikbi/` state dir, the LSP toolchain, and the auto-detected project type. Together they give
 * `ikbi doctor` the 8+ ✓/✗ checks the productization sprint calls for, each with a one-line fix.
 *
 * Pure over an injectable `DoctorEnvPorts` so the whole thing is unit-testable with no real OS
 * access; `liveDoctorEnvPorts()` wires the production implementations (process.version, a PATH
 * probe, statfs, git). Relevance is project-aware: an LSP server is only a ✗ when the language
 * it serves was actually detected.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { join } from "node:path";

import { detectProject, liveDetectPorts, summarize, type ProjectDetection } from "../modules/project-detection/index.js";

const OK = "✓";
const BAD = "✗";
const WARN = "⚠";

/** Severity of an environment check. `required` failures block; `recommended` warn; `info` is FYI. */
export type EnvCheckLevel = "required" | "recommended" | "info";

/** One environment check result. */
export interface EnvCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly level: EnvCheckLevel;
  /** Extra detail appended after the label (e.g. a version or a path). */
  readonly detail?: string;
  /** A one-line fix instruction, shown when `ok` is false. */
  readonly fix?: string;
}

/** The OS surface the environment checks read. Injectable so tests need no real host access. */
export interface DoctorEnvPorts {
  /** The running Node version string (e.g. "v22.3.0"). */
  nodeVersion(): string;
  /** True iff `cmd` resolves on PATH (a `command -v`-style probe). */
  onPath(cmd: string): boolean;
  /** True iff `dir` is inside a git working tree. */
  isGitRepo(dir: string): boolean;
  /** True iff a file/dir exists at `path`. */
  exists(path: string): boolean;
  /** Free bytes on the filesystem holding `dir`, or undefined if it can't be determined. */
  diskFreeBytes(dir: string): number | undefined;
  /** Detect the project at `dir` (marker-file based). */
  detect(dir: string): ProjectDetection;
}

/** Inputs to the environment report — all default to the live host / cwd. */
export interface DoctorEnvInputs {
  readonly projectRoot?: string;
  readonly ports?: DoctorEnvPorts;
  /** The state root whose `.ikbi`-style dir is checked (default: <projectRoot>/.ikbi). */
  readonly stateDir?: string;
}

/** The minimum Node major ikbi supports. */
const MIN_NODE_MAJOR = 18;
/** Warn when free disk drops below this (1 GiB). */
const LOW_DISK_BYTES = 1024 * 1024 * 1024;

/** Parse the major version out of a "vNN.x.y" string, or undefined. */
function nodeMajor(version: string): number | undefined {
  const m = /^v?(\d+)\./.exec(version);
  return m !== null ? Number(m[1]) : undefined;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${n} B`;
}

/** The LSP servers ikbi can use, each tied to the detected language(s) that make it relevant. */
const LSP_SERVERS: ReadonlyArray<{ cmd: string; label: string; languages: readonly string[]; install: string }> = [
  { cmd: "tsc", label: "tsc (TypeScript)", languages: ["TypeScript", "JavaScript"], install: "pnpm add -g typescript" },
  { cmd: "pyright", label: "pyright (Python)", languages: ["Python"], install: "pip install pyright (or npm i -g pyright)" },
  { cmd: "gopls", label: "gopls (Go)", languages: ["Go"], install: "go install golang.org/x/tools/gopls@latest" },
  { cmd: "rust-analyzer", label: "rust-analyzer (Rust)", languages: ["Rust"], install: "rustup component add rust-analyzer" },
];

/**
 * Run the environment checks. Pure over its ports — performs no real OS access of its own.
 * Returns the structured checks, the detected project, and a count of ✗ (required+recommended).
 */
export function runEnvironmentChecks(inp: DoctorEnvInputs = {}): {
  readonly checks: readonly EnvCheck[];
  readonly detection: ProjectDetection;
  readonly issues: number;
} {
  const ports = inp.ports ?? liveDoctorEnvPorts();
  const root = inp.projectRoot ?? process.cwd();
  const stateDir = inp.stateDir ?? join(root, ".ikbi");
  const checks: EnvCheck[] = [];

  // 1. Node version
  const version = ports.nodeVersion();
  const major = nodeMajor(version);
  checks.push({
    id: "node",
    label: "Node.js",
    detail: version,
    ok: major !== undefined && major >= MIN_NODE_MAJOR,
    level: "required",
    fix: `ikbi needs Node ${MIN_NODE_MAJOR}+ — upgrade (e.g. via nvm: nvm install ${MIN_NODE_MAJOR})`,
  });

  // 2. Package manager
  const hasPnpm = ports.onPath("pnpm");
  const hasNpm = ports.onPath("npm");
  checks.push({
    id: "package-manager",
    label: "Package manager",
    detail: hasPnpm ? "pnpm" : hasNpm ? "npm (pnpm recommended)" : "none found",
    ok: hasPnpm || hasNpm,
    level: "required",
    fix: "install pnpm (`npm i -g pnpm`) — ikbi's verifier runs tsc/tests through it",
  });

  // 3. git working tree
  const inGit = ports.isGitRepo(root);
  checks.push({
    id: "git",
    label: "Git repository",
    ok: inGit,
    level: "recommended",
    ...(inGit ? { detail: root } : {}),
    fix: "run `git init` — ikbi isolates work in git worktrees and diffs against HEAD",
  });

  // 4. .ikbi/ state directory
  const hasState = ports.exists(stateDir);
  checks.push({
    id: "state-dir",
    label: ".ikbi/ state directory",
    ok: hasState,
    level: "recommended",
    ...(hasState ? { detail: stateDir } : {}),
    fix: "run `ikbi init` or `ikbi doctor --fix` to create it",
  });

  // 5. disk space
  const free = ports.diskFreeBytes(root);
  if (free !== undefined) {
    checks.push({
      id: "disk",
      label: "Disk space",
      detail: `${fmtBytes(free)} free`,
      ok: free >= LOW_DISK_BYTES,
      level: "recommended",
      fix: "free up space (`ikbi clean` reclaims old worktrees) — builds need room for worktrees",
    });
  }

  // 6. project detection (informational line)
  const detection = ports.detect(root);
  checks.push({
    id: "project",
    label: "Detected project",
    detail: summarize(detection),
    ok: true,
    level: "info",
  });

  // 7+. LSP toolchain — each server is a ✗ only when its language was detected.
  for (const lsp of LSP_SERVERS) {
    const relevant = lsp.languages.some((l) => detection.languages.includes(l));
    const present = ports.onPath(lsp.cmd);
    checks.push({
      id: `lsp:${lsp.cmd}`,
      label: `LSP — ${lsp.label}`,
      ok: present || !relevant,
      // Relevant-but-missing is a recommendation; irrelevant-and-missing is just info.
      level: relevant ? "recommended" : "info",
      detail: present ? "installed" : relevant ? "not installed (used by this project)" : "not installed",
      ...(relevant ? { fix: `install for richer diagnostics: ${lsp.install}` } : {}),
    });
  }

  const issues = checks.filter((c) => !c.ok && c.level !== "info").length;
  return { checks, detection, issues };
}

/** Render the environment checks as a printable section (no trailing newline). */
export function renderEnvironmentChecks(checks: readonly EnvCheck[]): string {
  const lines: string[] = ["ENVIRONMENT"];
  for (const c of checks) {
    const mark = c.ok ? (c.level === "info" ? "·" : OK) : c.level === "required" ? BAD : WARN;
    const detail = c.detail !== undefined ? ` — ${c.detail}` : "";
    const fix = !c.ok && c.fix !== undefined ? `  → ${c.fix}` : "";
    lines.push(`  ${mark} ${c.label}${detail}${fix}`);
  }
  return lines.join("\n");
}

/** Wire the production OS ports (process.version, PATH probe, statfs, git). */
export function liveDoctorEnvPorts(): DoctorEnvPorts {
  const probe = (cmd: string, args: readonly string[]): boolean => {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  return {
    nodeVersion: () => process.version,
    // Resolve PATH without RUNNING the tool: `command -v` (POSIX) / `where` (Windows). The
    // candidate is passed as a positional ($0), never interpolated into the script — injection-safe.
    onPath: (cmd) => {
      try {
        if (process.platform === "win32") execFileSync("where", [cmd], { stdio: "ignore" });
        else execFileSync("sh", ["-c", 'command -v "$0"', cmd], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    isGitRepo: (dir) => probe("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]),
    exists: (p) => existsSync(p),
    diskFreeBytes: (dir) => {
      try {
        const s = statfsSync(dir);
        return s.bavail * s.bsize;
      } catch {
        return undefined;
      }
    },
    detect: (dir) => detectProject(dir, liveDetectPorts()),
  };
}
