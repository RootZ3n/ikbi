/**
 * ikbi repo-doctor — test health analyzer.
 *
 * Finds modules without matching test files.
 */

import { readdirSync, existsSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import type { DimensionReport, Finding } from "../contract.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const TEST_PATTERNS = [".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.tsx", ".spec.js"];

function walk(dir: string): string[] {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes(".test.") && !entry.name.includes(".spec.")) results.push(full);
  }
  return results;
}

function hasTestFile(file: string): boolean {
  const ext = extname(file);
  const base = file.slice(0, -ext.length);
  return TEST_PATTERNS.some((pat) => existsSync(base + pat)) ||
    existsSync(join(dirnameOf(file), "__tests__", basename(file)));
}

function dirnameOf(file: string): string {
  const parts = file.split("/");
  parts.pop();
  return parts.join("/");
}

export function analyze(repoPath: string): DimensionReport {
  const findings: Finding[] = [];
  const files = walk(repoPath);
  let score = 100;
  let untested = 0;

  for (const file of files) {
    const relPath = relative(repoPath, file);
    if (!hasTestFile(file)) {
      findings.push({
        dimension: "test-health",
        severity: "warning",
        message: `No matching test file found`,
        file: relPath,
        suggestion: `Add a test file: ${relPath.replace(/\.(ts|tsx|js|jsx)$/, ".test.$1")}`,
      });
      untested++;
    }
  }

  if (files.length > 0) {
    const coverage = (files.length - untested) / files.length;
    score = Math.round(coverage * 100);
  }

  return {
    dimension: "test-health",
    score: Math.max(0, Math.min(100, score)),
    findings,
    scannedAt: new Date().toISOString(),
  };
}
