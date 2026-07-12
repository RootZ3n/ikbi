/**
 * ikbi repo-doctor — module entrypoint.
 *
 * Runs all 6 health analyzers and produces a composite health report.
 * Wires the dormant project-index module into a visible health surface.
 */

import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
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
// Keyed by CANONICAL repo path (Codex H9): a single global report let one repo receive
// another repo's cached scan. Bounded FIFO so an attacker can't grow it without limit.
const MAX_CACHED_REPORTS = 32;
const reportCache = new Map<string, HealthReport>();

/** Get the cached report for a path or run a fresh scan. Cache is per-path. */
export function getReport(repoPath: string, force = false): HealthReport {
  const cached = reportCache.get(repoPath);
  if (cached !== undefined && !force) return cached;
  const report = runAllAnalyzers(repoPath);
  reportCache.set(repoPath, report);
  if (reportCache.size > MAX_CACHED_REPORTS) {
    const oldest = reportCache.keys().next().value;
    if (oldest !== undefined) reportCache.delete(oldest);
  }
  return report;
}

/** Test-only: clear the per-path report cache. */
export function resetReportCache(): void {
  reportCache.clear();
}

// ── Path confinement (Codex H9) ────────────────────────────────────────────
/** A rejected repo path (outside the allowed roots / not a directory). */
export class RepoDoctorPathError extends Error {}

/** Roots repo-doctor may scan: the process cwd + any operator-listed IKBI_REPO_DOCTOR_ROOTS (colon-sep). */
function allowedRoots(): string[] {
  const roots = [process.cwd()];
  const extra = process.env.IKBI_REPO_DOCTOR_ROOTS;
  if (extra !== undefined) {
    for (const r of extra.split(":")) {
      const t = r.trim();
      if (t.length > 0) roots.push(t);
    }
  }
  return roots.map((r) => { try { return realpathSync(resolve(r)); } catch { return resolve(r); } });
}

/**
 * Canonicalize + confine a requested repo path. Without this, `?repo=/etc` (or `/`) would trigger a
 * synchronous recursive scan of ANY host directory. Realpath defeats symlink escapes; the result must
 * be an existing directory AT or UNDER an allowed root.
 */
export function resolveRepoPath(input: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(input));
  } catch {
    throw new RepoDoctorPathError(`path does not exist or is not accessible: ${input}`);
  }
  try {
    if (!statSync(canonical).isDirectory()) throw new RepoDoctorPathError(`not a directory: ${input}`);
  } catch (e) {
    throw e instanceof RepoDoctorPathError ? e : new RepoDoctorPathError(`not a directory: ${input}`);
  }
  const ok = allowedRoots().some((root) => canonical === root || canonical.startsWith(root + sep));
  if (!ok) {
    throw new RepoDoctorPathError(`path "${input}" is outside the allowed repo-doctor roots (set IKBI_REPO_DOCTOR_ROOTS to permit it)`);
  }
  return canonical;
}

// ── Route registration ───────────────────────────────────────────────────
registerRoutes("repo-doctor", (app: FastifyInstance) => {
  // Resolve+confine the requested path, or send a 403 (never scan an arbitrary host dir).
  const confinedPath = (raw: string | undefined, reply: import("fastify").FastifyReply): string | undefined => {
    try {
      return resolveRepoPath(raw ?? process.cwd());
    } catch (e) {
      void reply.code(403);
      void reply.send({ error: e instanceof RepoDoctorPathError ? e.message : "invalid repo path" });
      return undefined;
    }
  };

  // Full health report
  app.get("/ikbi/repo-doctor/health", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const repoPath = confinedPath(query.repo, reply);
    if (repoPath === undefined) return reply;
    return getReport(repoPath);
  });

  // Single dimension
  app.get<{ Params: { dimension: string } }>("/ikbi/repo-doctor/health/:dimension", async (request, reply) => {
    const { dimension } = request.params;
    if (!DIMENSIONS.includes(dimension as HealthDimension)) {
      void reply.code(400);
      return { error: `Unknown dimension: ${dimension}. Valid: ${DIMENSIONS.join(", ")}` };
    }
    const query = request.query as Record<string, string>;
    const repoPath = confinedPath(query.repo, reply);
    if (repoPath === undefined) return reply;
    return runAnalyzer(dimension as HealthDimension, repoPath);
  });

  // Trigger fresh scan
  app.post("/ikbi/repo-doctor/scan", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const repoPath = confinedPath(body.repo, reply);
    if (repoPath === undefined) return reply;
    return getReport(repoPath, true);
  });
});
