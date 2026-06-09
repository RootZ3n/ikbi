/**
 * ikbi worker-model — PRODUCTION MODE RESOLUTION (pure, zero-import).
 *
 * Single source of truth for "which verification path / which retrieval path runs".
 * The HARDENED paths (ladder verification + index retrieval) are the PRODUCTION
 * DEFAULT; an operator opts BACK to a legacy path only by explicitly setting
 * `IKBI_VERIFY=legacy` / `IKBI_RETRIEVAL=legacy`. `IKBI_VERIFY=ladder` /
 * `IKBI_RETRIEVAL=index` remain valid explicit opt-ins (and are the production default).
 *
 * `production` is the gate the orchestrator passes (`enforceProjectRoot`): the live
 * `createProductionWorker` wiring is production; bare in-test construction is NOT, so
 * direct `createVerifier()` / `createScout()` callers keep their legacy-by-default
 * behavior byte-for-byte (back-compat). Pure functions of (env, production) — no I/O.
 */

/** The two verification paths. */
export type VerificationMode = "ladder" | "legacy";
/** The two retrieval paths (scout may further report an "index-fallback" at runtime). */
export type RetrievalMode = "index" | "legacy";

/** Resolve the verification mode. Production defaults to ladder; explicit env always wins. */
export function resolveVerificationMode(env: NodeJS.ProcessEnv, opts: { production: boolean }): VerificationMode {
  const raw = (env.IKBI_VERIFY ?? "").trim().toLowerCase();
  if (raw === "ladder") return "ladder";
  if (raw === "legacy") return "legacy";
  return opts.production ? "ladder" : "legacy";
}

/** Resolve the retrieval mode. Production defaults to index; explicit env always wins. */
export function resolveRetrievalMode(env: NodeJS.ProcessEnv, opts: { production: boolean }): RetrievalMode {
  const raw = (env.IKBI_RETRIEVAL ?? "").trim().toLowerCase();
  if (raw === "index") return "index";
  if (raw === "legacy") return "legacy";
  return opts.production ? "index" : "legacy";
}

/** True iff the operator EXPLICITLY opted out of hardened verification (legacy override). */
export function isExplicitLegacyVerify(env: NodeJS.ProcessEnv): boolean {
  return (env.IKBI_VERIFY ?? "").trim().toLowerCase() === "legacy";
}

/** True iff the operator EXPLICITLY opted out of hardened retrieval (legacy override). */
export function isExplicitLegacyRetrieval(env: NodeJS.ProcessEnv): boolean {
  return (env.IKBI_RETRIEVAL ?? "").trim().toLowerCase() === "legacy";
}

/** The combined safety posture an operator reads from doctor. */
export type SafetyPosture = "HARDENED" | "LEGACY" | "MIXED";

/** HARDENED iff both paths hardened, LEGACY iff both legacy, else MIXED. */
export function safetyPosture(verification: VerificationMode, retrieval: RetrievalMode): SafetyPosture {
  const vHard = verification === "ladder";
  const rHard = retrieval === "index";
  if (vHard && rHard) return "HARDENED";
  if (!vHard && !rHard) return "LEGACY";
  return "MIXED";
}
