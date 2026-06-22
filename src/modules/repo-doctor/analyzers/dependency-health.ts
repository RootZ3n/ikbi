/**
 * ikbi repo-doctor — dependency health analyzer.
 *
 * Finds circular dependencies and checks for dependency issues.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
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

/** Extract import specifiers from a file. */
function extractImports(content: string): string[] {
  const matches = content.match(/(?:import|from)\s+['"]([^'"]+)['"]/g) ?? [];
  return matches.map((m) => {
    const spec = m.match(/['"]([^'"]+)['"]/);
    return spec ? spec[1]! : "";
  }).filter(Boolean);
}

export function analyze(repoPath: string): DimensionReport {
  const findings: Finding[] = [];
  const files = walkTs(repoPath);
  let score = 100;

  // Build adjacency: file → set of local imports
  const adj = new Map<string, Set<string>>();
  for (const file of files) {
    const relPath = relative(repoPath, file);
    try {
      const content = readFileSync(file, "utf8");
      const imports = extractImports(content);
      const localImports = new Set<string>();
      for (const imp of imports) {
        if (imp.startsWith(".")) {
          // Resolve relative import — handle .js → .ts mapping
          let resolved = join(relPath, "..", imp).replace(/\\/g, "/");
          localImports.add(resolved);
          // Also add .ts variant if import uses .js extension
          if (resolved.endsWith(".js")) {
            localImports.add(resolved.replace(/\.js$/, ".ts"));
            localImports.add(resolved.replace(/\.js$/, ".tsx"));
          }
        }
      }
      adj.set(relPath, localImports);
    } catch { /* skip */ }
  }

  // Detect circular imports (simple DFS)
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) cycles.push(path.slice(cycleStart));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    path.push(node);
    for (const dep of adj.get(node) ?? []) {
      dfs(dep, path);
    }
    path.pop();
    inStack.delete(node);
  }

  for (const node of adj.keys()) {
    dfs(node, []);
  }

  for (const cycle of cycles) {
    findings.push({
      dimension: "dependency-health",
      severity: "critical",
      message: `Circular dependency: ${cycle.join(" → ")}`,
      suggestion: "Break the cycle by extracting shared types or using dependency injection",
    });
    score -= 10;
  }

  // Check package.json existence
  if (!existsSync(join(repoPath, "package.json"))) {
    findings.push({
      dimension: "dependency-health",
      severity: "warning",
      message: "No package.json found in repo root",
    });
    score -= 5;
  }

  return {
    dimension: "dependency-health",
    score: Math.max(0, Math.min(100, score)),
    findings,
    scannedAt: new Date().toISOString(),
  };
}
