// @ts-nocheck
/**
 * In-process HTTP-surface probe. Builds the real Fastify app (buildServer) and
 * injects requests at the routes that engine modules register on the registry
 * seam — chat, repo-doctor, correction-library, job-cards, spec-artifact — plus
 * the always-on /health and /capabilities. Exits cleanly so V8 coverage flushes.
 *
 * This is the ONLY probe that imports engine internals; it exists solely to reach
 * the HTTP route handlers the CLI surfaces cannot touch.
 */
// Import the module barrel FIRST — exactly as `ikbi serve` (via cli/index.js) does.
// The barrel installs the egress fetch-guard floor and fires every module's
// registerRoutes(...) side effect; buildServer() only picks up already-registered
// routes. Skipping this is why a bare buildServer 404s the module routes.
import "../../dist/modules/index.js";
import { buildServer } from "../../dist/server/index.js";

const app = buildServer();
await app.ready();

const calls = [
  ["GET", "/health"],
  ["GET", "/ready"],
  ["GET", "/capabilities"],
  ["GET", "/ikbi/repo-doctor/health"],
  ["GET", "/ikbi/repo-doctor/health/file-health"],
  ["POST", "/ikbi/repo-doctor/scan", { repoPath: process.cwd() }],
  ["GET", "/ikbi/spec-artifact/specs"],
  ["GET", "/ikbi/job-cards/cards"],
  ["GET", "/ikbi/correction-library/corrections"],
  ["POST", "/chat", { message: "hello" }],
];

for (const [method, url, payload] of calls) {
  try {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    process.stderr.write(`  ${method} ${url} -> ${res.statusCode}\n`);
  } catch (e) {
    process.stderr.write(`  ${method} ${url} -> ERR ${e?.message}\n`);
  }
}

await app.close();
process.exit(0);
