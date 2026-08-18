/**
 * ikbi profiles — named model strategies.
 *
 * A profile describes WHICH of the available models ikbi should use right now,
 * in which roles, with which settings. This is separate from provider configuration
 * (which models CAN this machine access).
 *
 * Profiles live in ~/.ikbi/profiles/<name>.json
 * The active profile pointer lives in ~/.ikbi/state/active-profile
 */

/** A single role assignment within a profile. */
export interface ProfileRole {
  readonly provider: string;
  readonly model: string;
}

/** Routing hints for the profile. */
export interface ProfileRouting {
  readonly cheap_tier?: string;
  readonly fallback_profile?: string;
}

/** A complete model-strategy profile. */
export interface Profile {
  readonly name: string;
  readonly extends?: string;
  readonly description?: string;
  readonly roles: Record<string, ProfileRole>;
  readonly routing?: ProfileRouting;
  readonly parameters?: Record<string, unknown>;
  readonly max_run_cost?: number;
}

/** The result of validating a profile against the current provider roster. */
export interface ProfileValidationResult {
  readonly valid: boolean;
  readonly profile: string;
  readonly roles: ProfileRoleValidation[];
  readonly errors: string[];
}

/** Validation status for a single role within a profile. */
export interface ProfileRoleValidation {
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly modelInRoster: boolean;
  readonly providerReady: boolean;
  readonly ok: boolean;
  readonly error?: string | undefined;
}

/** What gets written to the active-profile pointer file. */
export interface ActiveProfilePointer {
  readonly name: string;
  readonly activatedAt: string;
}

/** The set of roles ikbi knows about. */
export const KNOWN_ROLES = [
  "classifier",
  "scout",
  "builder",
  "critic",
  "fixer",
  "rescue",
  "recovery-worker",
  "recovery-mid",
  "consult",
] as const;

export type KnownRole = (typeof KNOWN_ROLES)[number];

/** Which roles are required for a build to proceed. */
export const REQUIRED_ROLES: readonly KnownRole[] = [
  "builder",
  "critic",
] as const;

/** Default profile names that ship with ikbi. */
export const BUILTIN_PROFILE_NAMES = ["mimo", "deepseek", "premium"] as const;
