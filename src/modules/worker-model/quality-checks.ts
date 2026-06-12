/**
 * ikbi worker-model — QUALITY CHECKS (deterministic, post-verification).
 *
 * Runs AFTER typecheck and tests pass. Detects quality issues that the
 * compiler and test suite cannot catch:
 *
 *  1. Empty files (0 bytes) — the builder wrote a placeholder that does nothing.
 *  2. Stub detection — files containing only comments, empty exports, or TODO/FIXME.
 *  3. Location check — files in node_modules/, .git/, dist/, etc. are blocked.
 *  4. Import coherence — TypeScript imports reference files that actually exist.
 *
 * Deterministic: no model calls. Fast: pure fs reads, < 1 second.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────────

/** One individual quality issue found. */
export interface QualityIssue {
  readonly kind: "empty_file" | "stub_file" | "bad_location" | "broken_import";
  readonly file: string;
  readonly detail: string;
}

/** The result of running all quality checks. */
export interface QualityResult {
  readonly pass: boolean;
  readonly issues: readonly QualityIssue[];
}

// ── Blocked directories ────────────────────────────────────────────────────────

/** Directories files must NOT be written into. */
const BLOCKED_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".cache",
  ".turbo",
  ".nuxt",
  "build",
  "coverage",
  ".pnpm-store",
];

// ── Stub detection ─────────────────────────────────────────────────────────────

/**
 * Is the file content a "stub"? A stub is:
 *  - Empty / whitespace-only
 *  - Only comments (//, /*, #, etc.)
 *  - Only empty exports (export {}; or export default {};)
 *  - Content that is exclusively TODO/FIXME/HACK/XXX placeholder text
 */
function isStubContent(content: string, filePath?: string): boolean {
  // .d.ts files are type declarations — triple-slash directives and ambient types are
  // legitimate content, not stubs. Skip stub detection for declaration files.
  if (filePath !== undefined && filePath.endsWith(".d.ts")) return false;

  // Strip: block comments, line comments, shebang, empty lines, whitespace
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*(\/\/|#|\/\*|\*\/|\*)\s*.*$/gm, "") // line comments (//, #, *, */)
    .replace(/^\s*$/gm, "") // empty lines
    .trim();

  if (stripped.length === 0) return true;

  // Only empty exports
  if (/^(export\s*(default\s*)?\{\s*\}\s*;?\s*)+$/m.test(stripped)) return true;

  // Only placeholder markers (TODO, FIXME, HACK, XXX) with optional surrounding text
  const lines = stripped.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return true;
  const placeholderOnly = lines.every((line) => {
    const t = line.trim();
    // A line is a placeholder if it's just a TODO/FIXME/HACK/XXX marker
    return /^(TODO|FIXME|HACK|XXX|PLACEHOLDER|STUB|Not implemented|Not yet implemented|noop|pass)[:\s\-—]*.*$/i.test(t);
  });
  return placeholderOnly;
}

// ── Import coherence ───────────────────────────────────────────────────────────

/** Regex for ES module imports + CommonJS require. */
const IMPORT_RE = /(?:import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\))/g;

/** Resolve an import specifier to a file path in the workspace. */
function resolveImport(specifier: string, fromFile: string, workspacePath: string): boolean {
  // Skip non-relative imports (node_modules, bare specifiers)
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return true;
  if (specifier.startsWith("@")) return true; // scoped packages

  const fromDir = dirname(fromFile);
  const base = specifier.startsWith("/")
    ? join(workspacePath, specifier)
    : resolve(workspacePath, fromDir, specifier);

  // Try with common extensions
  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
  if (exts.some((ext) => existsSync(base + ext))) return true;

  // TypeScript convention: import "./foo.js" resolves to "./foo.ts"
  if (base.endsWith(".js")) {
    const tsBase = base.slice(0, -3);
    if (existsSync(tsBase + ".ts") || existsSync(tsBase + ".tsx")) return true;
  }
  return false;
}

// ── Main quality check function ────────────────────────────────────────────────

/**
 * Run all quality checks against the written files.
 *
 * @param workspacePath - Absolute path to the workspace root.
 * @param writtenFiles  - Relative paths (POSIX) of files the builder wrote.
 * @param allWorkspaceFiles - Optional: all files in workspace for import coherence.
 *                           When omitted, import coherence checks are skipped.
 */
export function runQualityChecks(
  workspacePath: string,
  writtenFiles: readonly string[],
  _allWorkspaceFiles?: readonly string[],
): QualityResult {
  const issues: QualityIssue[] = [];
  const wsRoot = resolve(workspacePath);

  for (const relPath of writtenFiles) {
    const fullPath = join(wsRoot, relPath);
    const normalized = relPath.replace(/\\/g, "/");

    // 1. Location check — block writes into dependency/build dirs
    const pathParts = normalized.split("/");
    const inBlockedDir = pathParts.some((part) => BLOCKED_DIRS.includes(part));
    if (inBlockedDir) {
      issues.push({
        kind: "bad_location",
        file: relPath,
        detail: `file is inside a blocked directory (${BLOCKED_DIRS.join(", ")}): ${relPath}`,
      });
      // Skip further checks for blocked files (they shouldn't exist at all)
      continue;
    }

    // 2. Empty file check (0 bytes)
    if (existsSync(fullPath)) {
      const stat = statSync(fullPath);
      if (stat.size === 0) {
        issues.push({
          kind: "empty_file",
          file: relPath,
          detail: `file is empty (0 bytes): ${relPath}`,
        });
        continue; // don't also flag as stub
      }

      // 3. Stub detection — only for text-like files
      const ext = extname(relPath).toLowerCase();
      const textExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml", ".css", ".scss", ".html", ".vue", ".svelte"];
      if (textExts.includes(ext)) {
        const content = readFileSync(fullPath, "utf8");
        if (content.trim().length > 0 && isStubContent(content, relPath)) {
          issues.push({
            kind: "stub_file",
            file: relPath,
            detail: `file appears to be a stub (only comments/empty exports/placeholder text): ${relPath}`,
          });
        }
      }

      // 4. Import coherence — for TypeScript/JavaScript files
      const codeExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
      if (codeExts.includes(ext)) {
        const content = readFileSync(fullPath, "utf8");
        let match: RegExpExecArray | null;
        IMPORT_RE.lastIndex = 0;
        while ((match = IMPORT_RE.exec(content)) !== null) {
          const specifier = (match[1] ?? match[2]) as string;
          if (specifier !== undefined && !resolveImport(specifier, normalized, wsRoot)) {
            issues.push({
              kind: "broken_import",
              file: relPath,
              detail: `import "${specifier}" does not resolve to a file in the workspace (from ${relPath})`,
            });
          }
        }
      }
    }
  }

  return { pass: issues.length === 0, issues };
}
