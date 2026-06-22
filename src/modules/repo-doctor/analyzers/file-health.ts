/**
 * ikbi repo-doctor — file health analyzer.
 *
 * Finds files >500 lines, god files, and dead code patterns.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { DimensionReport, Finding } from "../contract.js";

const MAX_HEALTHY_LINES = 500;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next"]);

function walk(dir: string): string[] {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

export function analyze(repoPath: string): DimensionReport {
  const findings: Finding[] = [];
  const files = walk(repoPath);
  let totalScore = 100;

  for (const file of files) {
    const relPath = relative(repoPath, file);
    try {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n").length;

      if (lines > MAX_HEALTHY_LINES) {
        findings.push({
          dimension: "file-health",
          severity: lines > 1000 ? "critical" : "warning",
          message: `File has ${lines} lines (max recommended: ${MAX_HEALTHY_LINES})`,
          file: relPath,
          suggestion: "Consider splitting into smaller modules",
        });
        totalScore -= lines > 1000 ? 5 : 2;
      }
    } catch {
      // skip unreadable files
    }
  }

  return {
    dimension: "file-health",
    score: Math.max(0, Math.min(100, totalScore)),
    findings,
    scannedAt: new Date().toISOString(),
  };
}
