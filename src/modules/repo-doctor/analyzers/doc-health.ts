/**
 * ikbi repo-doctor — doc health analyzer.
 *
 * Finds stale READMEs and missing JSDoc on exported functions.
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

function findReadmes(dir: string): string[] {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findReadmes(full));
    else if (entry.isFile() && /^readme\.md$/i.test(entry.name)) results.push(full);
  }
  return results;
}

export function analyze(repoPath: string): DimensionReport {
  const findings: Finding[] = [];
  let score = 100;

  const readmes = new Set(findReadmes(repoPath).map((r) => relative(repoPath, join(r, ".."))));
  const tsFiles = walkTs(repoPath);
  const dirsWithCode = new Set(tsFiles.map((f) => {
    const parts = relative(repoPath, f).split("/");
    parts.pop();
    return parts.join("/");
  }));

  for (const dir of dirsWithCode) {
    if (dir && !readmes.has(dir) && !dir.includes("/") && dir !== "src") {
      findings.push({
        dimension: "doc-health",
        severity: "info",
        message: `Directory "${dir}" has source files but no README`,
        suggestion: "Add a README.md documenting the module's purpose",
      });
      score -= 1;
    }
  }

  for (const file of tsFiles) {
    const relPath = relative(repoPath, file);
    try {
      const content = readFileSync(file, "utf8");
      const exportMatches = content.match(/(?:export\s+(?:function|const|class|interface|type)\s+\w+)/g) ?? [];
      const jsdocCount = (content.match(/\/\*\*/g) ?? []).length;
      if (exportMatches.length > 3 && jsdocCount < exportMatches.length / 2) {
        findings.push({
          dimension: "doc-health",
          severity: "info",
          message: `${exportMatches.length} exports but only ${jsdocCount} JSDoc comments`,
          file: relPath,
          suggestion: "Add JSDoc comments to exported functions and types",
        });
        score -= 1;
      }
    } catch { /* skip */ }
  }

  return {
    dimension: "doc-health",
    score: Math.max(0, Math.min(100, score)),
    findings,
    scannedAt: new Date().toISOString(),
  };
}
