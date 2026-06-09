/**
 * ikbi verification-ladder — config slice (`moduleEnv("verification-ladder")`, prefix
 * `IKBI_VERIFICATION_LADDER_`). No core-config edits.
 *
 *   IKBI_VERIFICATION_LADDER_MAX_IMPACT_HOPS         reverse-import dependent depth. Default 3.
 *   IKBI_VERIFICATION_LADDER_MAX_IMPACT_FILES        cap on collected dependents. Default 2000.
 *   IKBI_VERIFICATION_LADDER_MAX_CROSS_PACKAGE       cross-package importers tolerated before
 *                                                    escalating to full. Default 0 (any ⇒ full).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("verification-ladder");

export const DEFAULT_MAX_IMPACT_HOPS = 3;
export const DEFAULT_MAX_IMPACT_FILES = 2_000;
export const DEFAULT_MAX_CROSS_PACKAGE = 0;

/** package.json script keys the ladder can run, in priority order (test fastest signal first). */
export const RUNNABLE_SCRIPT_KEYS: readonly string[] = ["test", "typecheck", "build"];

/** A changed file matching any of these forces FULL verification (shared/root surface). */
export const SHARED_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/,
  /^\.github\//,
];

export interface VerificationLadderConfig {
  readonly maxImpactHops: number;
  readonly maxImpactFiles: number;
  readonly maxCrossPackage: number;
}

export function loadVerificationLadderConfig(reader = env): VerificationLadderConfig {
  return Object.freeze({
    maxImpactHops: reader.int("MAX_IMPACT_HOPS", DEFAULT_MAX_IMPACT_HOPS, { min: 0 }),
    maxImpactFiles: reader.int("MAX_IMPACT_FILES", DEFAULT_MAX_IMPACT_FILES, { min: 1 }),
    maxCrossPackage: reader.int("MAX_CROSS_PACKAGE", DEFAULT_MAX_CROSS_PACKAGE, { min: 0 }),
  });
}

export const verificationLadderConfig: VerificationLadderConfig = loadVerificationLadderConfig();
