/**
 * Velum — AI Privacy & Injection Defense
 * ============================================================
 * Health-check utility. Provides a simple liveness/readiness probe.
 * ============================================================
 */

import { readFileSync } from "node:fs";

/** Read the real version from package.json (avoids hardcoded drift). */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();

export interface HealthCheckResult {
  status: "ok";
  service: "velum";
  version: string;
}

/**
 * Returns a simple health-check result indicating that the Velum module
 * is alive and operational.
 */
export function velumHealthCheck(): HealthCheckResult {
  return { status: "ok", service: "velum", version: VERSION };
}
