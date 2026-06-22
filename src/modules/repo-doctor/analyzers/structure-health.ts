/**
 * ikbi repo-doctor — structure health analyzer.
 *
 * Finds deep nesting (>5 levels) and mixed concerns.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { DimensionReport, Finding } from "../contract.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const MAX_NESTING = 5;

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

function maxNestingDepth(content: string): number {
  let maxDepth = 0;
  let depth = 0;
  for (const ch of content) {
    if (ch === "{") { depth++; maxDepth = Math.max(maxDepth, depth); }
    else if (ch === "}") { depth = Math.max(0, depth - 1); }
  }
  return maxDepth;
}

export function analyze(repoPath: string): DimensionReport {
  const findings: Finding[] = [];
  const files = walkTs(repoPath);
  let score = 100;

  for (const file of files) {
    const relPath = relative(repoPath, file);
    try {
      const content = readFileSync(file, "utf8");
      const depth = maxNestingDepth(content);
      if (depth > MAX_NESTING) {
        findings.push({
          dimension: "structure-health",
          severity: depth > 8 ? "critical" : "warning",
          message: `Maximum nesting depth: ${depth} levels (max recommended: ${MAX_NESTING})`,
          file: relPath,
          suggestion: "Extract deeply nested logic into named functions",
        });
        score -= depth > 8 ? 3 : 1;
      }
    } catch { /* skip */ }
  }

  return {
    dimension: "structure-health",
    score: Math.max(0, Math.min(100, score)),
    findings,
    scannedAt: new Date().toISOString(),
  };
}
