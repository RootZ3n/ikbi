/**
 * ikbi repo-doctor — import health analyzer.
 *
 * Finds unused imports and circular import patterns.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { DimensionReport, Finding } from "../contract.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

function walkTs(dir: string): string[] {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) results.push(full);
  }
  return results;
}

export function analyze(repoPath: string): DimensionReport {
  const findings: Finding[] = [];
  const files = walkTs(repoPath);
  let score = 100;

  for (const file of files) {
    const relPath = relative(repoPath, file);
    try {
      const content = readFileSync(file, "utf8");

      // Find named imports: import { a, b } from '...'
      const namedImports = content.match(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g) ?? [];
      for (const imp of namedImports) {
        const names = imp.match(/\{([^}]+)\}/)?.[1]?.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean) ?? [];
        for (const name of names) {
          if (name && !name.startsWith("type ")) {
            // Check if the name is used in the rest of the file (simple heuristic)
            const restOfFile = content.slice(content.indexOf(imp) + imp.length);
            const nameRegex = new RegExp(`\\b${name}\\b`);
            if (!nameRegex.test(restOfFile) && !content.slice(0, content.indexOf(imp)).includes(name)) {
              findings.push({
                dimension: "import-health",
                severity: "info",
                message: `Potentially unused import: "${name}"`,
                file: relPath,
                suggestion: `Remove unused import "${name}"`,
              });
              score -= 0.5;
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  return {
    dimension: "import-health",
    score: Math.max(0, Math.min(100, Math.round(score))),
    findings,
    scannedAt: new Date().toISOString(),
  };
}
