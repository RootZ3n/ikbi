/**
 * ikbi chat — PROJECT AUTO-DISCOVERY (REPL FIX 2).
 *
 * On REPL startup we scan the worktree and print a one-line project overview: the detected
 * language/framework, source + test file counts, the workspace path, and whether project
 * instructions (CLAUDE.md / AGENTS.md) are present. Pure + bounded — it walks the tree once,
 * skipping the usual noise dirs (node_modules, .git, dist, …) and capping the file budget so
 * a giant monorepo can never wedge startup.
 */

import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

/** A scanned project's shape, ready to format for the REPL banner. */
export interface ProjectOverview {
  /** Human label for the detected stack ("TypeScript", "Rust", …) or "source". */
  readonly language: string;
  /** Count of source files (by known source extension). */
  readonly sourceFiles: number;
  /** Count of test files (a subset of sourceFiles matching *.test.* / *.spec.* / *_test.*). */
  readonly testFiles: number;
  /** The scanned workspace path. */
  readonly workspace: string;
  /** The project-instructions file found at the root ("CLAUDE.md" / "AGENTS.md"), if any. */
  readonly instructionsFile?: string;
}

/** Directories never worth walking for a project overview. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".cache", "coverage", "vendor", ".venv", "__pycache__",
]);

/** Source-file extensions we count toward the overview. */
const SOURCE_EXTS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".py", ".java", ".rb", ".c", ".h", ".cpp", ".cc", ".cs",
]);

/** Hard cap on files visited — a runaway-tree backstop (startup must stay snappy). */
const MAX_FILES = 20_000;

/** True for a test-file name by the common conventions (*.test.* / *.spec.* / *_test.*). */
function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[A-Za-z0-9]+$/.test(name) || /_test\.[A-Za-z0-9]+$/.test(name);
}

/** Detect the stack label from root marker files (most specific wins). */
function detectLanguage(root: string): string {
  const has = (f: string): boolean => {
    try {
      return readdirSync(root).includes(f);
    } catch {
      return false;
    }
  };
  if (has("tsconfig.json")) return "TypeScript";
  if (has("Cargo.toml")) return "Rust";
  if (has("go.mod")) return "Go";
  if (has("pyproject.toml")) return "Python";
  if (has("package.json")) return "Node/JavaScript";
  return "source";
}

/** Find the root project-instructions file, if any (CLAUDE.md preferred over AGENTS.md). */
function findInstructions(root: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  if (entries.includes("CLAUDE.md")) return "CLAUDE.md";
  if (entries.includes("AGENTS.md")) return "AGENTS.md";
  return undefined;
}

/**
 * Scan a worktree and return its overview. Never throws past the call boundary — an
 * unreadable directory just contributes nothing to the counts.
 */
export function discoverProject(workspace: string): ProjectOverview {
  let sourceFiles = 0;
  let testFiles = 0;
  let visited = 0;
  const walk = (dir: string): void => {
    if (visited >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (visited >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name));
      } else if (e.isFile()) {
        visited += 1;
        if (SOURCE_EXTS.has(extname(e.name).toLowerCase())) {
          sourceFiles += 1;
          if (isTestFile(e.name)) testFiles += 1;
        }
      }
    }
  };
  walk(workspace);
  const instructionsFile = findInstructions(workspace);
  return {
    language: detectLanguage(workspace),
    sourceFiles,
    testFiles,
    workspace,
    ...(instructionsFile !== undefined ? { instructionsFile } : {}),
  };
}

/** Render the overview as the REPL startup banner lines (one or two lines, newline-terminated). */
export function formatOverview(o: ProjectOverview): string {
  const label = o.language === "source" ? "source project" : `${o.language} project`;
  let out = `📦 ${label} · ${o.sourceFiles} source file${o.sourceFiles === 1 ? "" : "s"} · ${o.testFiles} test file${o.testFiles === 1 ? "" : "s"} · workspace: ${o.workspace}\n`;
  if (o.instructionsFile !== undefined) out += `📋 Project instructions loaded from ${o.instructionsFile}\n`;
  return out;
}
