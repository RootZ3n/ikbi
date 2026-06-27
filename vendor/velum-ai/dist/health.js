/**
 * Velum — AI Privacy & Injection Defense
 * ============================================================
 * Health-check utility. Provides a simple liveness/readiness probe.
 * ============================================================
 */
import { readFileSync } from "node:fs";
/** Read the real version from package.json (avoids hardcoded drift). */
function readVersion() {
    try {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
        return pkg.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
const VERSION = readVersion();
/**
 * Returns a simple health-check result indicating that the Velum module
 * is alive and operational.
 */
export function velumHealthCheck() {
    return { status: "ok", service: "velum", version: VERSION };
}
//# sourceMappingURL=health.js.map