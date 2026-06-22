/**
 * ikbi repo-doctor — module entrypoint.
 *
 * Runs all 6 health analyzers and produces a composite health report.
 * Wires the dormant project-index module into a visible health surface.
 */

import type { FastifyInstance } from "fastify";
import { registerRoutes } from "../../server/registry.js";
import type { HealthReport, HealthDimension, DimensionReport } from "./contract.js";
import { analyze as analyzeFileHealth } from "./analyzers/file-health.js";
import { analyze as analyzeDependencyHealth } from "./analyzers/dependency-health.js";
import { analyze as analyzeTestHealth } from "./analyzers/test-health.js";
import { analyze as analyzeDocHealth } from "./analyzers/doc-health.js";
import { analyze as analyzeImportHealth } from "./analyzers/import-health.js";
import { analyze as analyzeStructureHealth } from "./analyzers/structure-health.js";

export type { HealthReport, HealthDimension, DimensionReport, Finding, FindingSeverity } from "./contract.js";

const ANALYZERS: Record<HealthDimension, (repoPath: string) => DimensionReport> = {
  "file-health": analyzeFileHealth,
  "dependency-health": analyzeDependencyHealth,
  "test-health": analyzeTestHealth,
  "doc-health": analyzeDocHealth,
  "import-health": analyzeImportHealth,
  "structure-health": analyzeStructureHealth,
};

/** All 6 dimension names. */
export const DIMENSIONS: readonly HealthDimension[] = Object.keys(ANALYZERS) as HealthDimension[];

/** Run all analyzers against a repo path. */
export function runAllAnalyzers(repoPath: string): HealthReport {
  const dimensions = DIMENSIONS.map((dim) => ANALYZERS[dim](repoPath));
  const overallScore = dimensions.length > 0
    ? Math.round(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length)
    : 0;
  return {
    overallScore,
    dimensions,
    scannedAt: new Date().toISOString(),
    repoPath,
  };
}

/** Run a single analyzer by dimension name. */
export function runAnalyzer(dimension: HealthDimension, repoPath: string): DimensionReport {
  const analyzer = ANALYZERS[dimension];
  if (!analyzer) throw new Error(`Unknown dimension: ${dimension}`);
  return analyzer(repoPath);
}

// ── Cache ────────────────────────────────────────────────────────────────
let cachedReport: HealthReport | undefined;

/** Get the cached report or run a fresh scan. */
export function getReport(repoPath: string, force = false): HealthReport {
  if (!cachedReport || force) {
    cachedReport = runAllAnalyzers(repoPath);
  }
  return cachedReport;
}

// ── Route registration ───────────────────────────────────────────────────
registerRoutes("repo-doctor", (app: FastifyInstance) => {
  // Full health report
  app.get("/ikbi/repo-doctor/health", async (request) => {
    const query = request.query as Record<string, string>;
    const repoPath = query.repo ?? process.cwd();
    const report = getReport(repoPath);
    return report;
  });

  // Single dimension
  app.get<{ Params: { dimension: string } }>("/ikbi/repo-doctor/health/:dimension", async (request, reply) => {
    const { dimension } = request.params;
    if (!DIMENSIONS.includes(dimension as HealthDimension)) {
      void reply.code(400);
      return { error: `Unknown dimension: ${dimension}. Valid: ${DIMENSIONS.join(", ")}` };
    }
    const query = request.query as Record<string, string>;
    const repoPath = query.repo ?? process.cwd();
    return runAnalyzer(dimension as HealthDimension, repoPath);
  });

  // Trigger fresh scan
  app.post("/ikbi/repo-doctor/scan", async (request) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const repoPath = body.repo ?? process.cwd();
    cachedReport = runAllAnalyzers(repoPath);
    return cachedReport;
  });
});
