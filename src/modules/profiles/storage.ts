/**
 * Profile storage — load, save, list, validate, switch.
 *
 * Profiles are JSON files in <stateRoot>/profiles/<name>.json.
 * The active profile pointer is <stateRoot>/active-profile.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";

import { childLogger } from "../../core/log.js";
import type { ModelProvider } from "../../core/provider/contract.js";
import type { ModelSpec } from "../../core/provider/registry.js";
import type {
  Profile,
  ProfileRoleValidation,
  ProfileValidationResult,
} from "./contract.js";
import { REQUIRED_ROLES, KNOWN_ROLES } from "./contract.js";

const log = childLogger("profiles");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function profilesDir(stateRoot: string): string {
  return join(stateRoot, "profiles");
}

export function activeProfilePath(stateRoot: string): string {
  return join(stateRoot, "active-profile");
}

function profileFilePath(stateRoot: string, name: string): string {
  return join(profilesDir(stateRoot), `${name}.json`);
}

// ---------------------------------------------------------------------------
// Profile loading
// ---------------------------------------------------------------------------

/** Load a single profile by name. Returns undefined if not found. */
export function loadProfile(stateRoot: string, name: string): Profile | undefined {
  const path = profileFilePath(stateRoot, name);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const doc = JSON.parse(raw) as Profile;
    if (typeof doc !== "object" || doc === null || typeof doc.name !== "string") {
      log.warn({ path }, "invalid profile file — skipping");
      return undefined;
    }
    return doc;
  } catch (err) {
    log.warn({ err, path }, "failed to read profile file — skipping");
    return undefined;
  }
}

/** List all available profile names. */
export function listProfiles(stateRoot: string): string[] {
  const dir = profilesDir(stateRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .sort();
}

/** Get the active profile name, or undefined if none is set. */
export function getActiveProfileName(stateRoot: string): string | undefined {
  const path = activeProfilePath(stateRoot);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Get the active profile, resolving inheritance. Returns undefined if none. */
export function getActiveProfile(stateRoot: string): Profile | undefined {
  const name = getActiveProfileName(stateRoot);
  if (name === undefined) return undefined;
  return resolveProfile(stateRoot, name);
}

/**
 * Resolve a profile with inheritance. The `extends` chain is followed up to
 * 5 levels deep. Child values override parent values (shallow merge per role).
 */
export function resolveProfile(stateRoot: string, name: string, depth = 0): Profile | undefined {
  if (depth > 5) {
    log.warn({ name, depth }, "profile inheritance too deep — circular extends?");
    return undefined;
  }
  const raw = loadProfile(stateRoot, name);
  if (raw === undefined) return undefined;
  if (raw.extends === undefined) return raw;

  const parent = resolveProfile(stateRoot, raw.extends, depth + 1);
  if (parent === undefined) {
    log.warn({ name, extends: raw.extends }, "parent profile not found — using without inheritance");
    return raw;
  }

  // Merge: child overrides parent
  return {
    ...parent,
    ...raw,
    name: raw.name,
    extends: raw.extends,
    roles: { ...parent.roles, ...raw.roles },
    routing: { ...parent.routing, ...raw.routing },
    parameters: { ...parent.parameters, ...raw.parameters },
  };
}

// ---------------------------------------------------------------------------
// Profile saving
// ---------------------------------------------------------------------------

/** Save a profile to disk. Creates the profiles directory if needed. */
export async function saveProfile(stateRoot: string, profile: Profile): Promise<void> {
  const dir = profilesDir(stateRoot);
  await mkdir(dir, { recursive: true });
  const path = profileFilePath(stateRoot, profile.name);
  await writeFile(path, JSON.stringify(profile, null, 2) + "\n", "utf8");
  log.info({ name: profile.name, path }, "saved profile");
}

/** Delete a profile from disk. Returns true if deleted, false if not found. */
export async function deleteProfile(stateRoot: string, name: string): Promise<boolean> {
  const path = profileFilePath(stateRoot, name);
  if (!existsSync(path)) return false;
  await unlink(path);
  log.info({ name }, "deleted profile");
  return true;
}

// ---------------------------------------------------------------------------
// Active profile switching
// ---------------------------------------------------------------------------

/**
 * Atomically switch the active profile.
 *
 * 1. Load and resolve the profile (with inheritance)
 * 2. Validate all roles against the provider roster
 * 3. If validation passes, write the active-profile pointer
 * 4. If validation fails, return errors WITHOUT changing the active profile
 */
export async function switchProfile(
  stateRoot: string,
  name: string,
  registry: ProfileRegistry,
): Promise<ProfileSwitchResult> {
  // 1. Load and resolve
  const profile = resolveProfile(stateRoot, name);
  if (profile === undefined) {
    return {
      success: false,
      profile: name,
      validation: {
        valid: false,
        profile: name,
        roles: [],
        errors: [`Profile "${name}" not found`],
      },
      previousProfile: getActiveProfileName(stateRoot),
    };
  }

  // 2. Validate
  const validation = validateProfile(profile, registry);
  if (!validation.valid) {
    return {
      success: false,
      profile: name,
      validation,
      previousProfile: getActiveProfileName(stateRoot),
    };
  }

  // 3. Write pointer
  const path = activeProfilePath(stateRoot);
  await mkdir(stateRoot, { recursive: true });
  await writeFile(path, name + "\n", "utf8");
  log.info({ name }, "switched active profile");

  return {
    success: true,
    profile: name,
    validation,
    previousProfile: getActiveProfileName(stateRoot),
  };
}

/** Clear the active profile (revert to built-in defaults). */
export async function clearActiveProfile(stateRoot: string): Promise<void> {
  const path = activeProfilePath(stateRoot);
  if (existsSync(path)) {
    await unlink(path);
    log.info("cleared active profile");
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The registry surface profiles need for validation. */
export interface ProfileRegistry {
  getModel: (id: string) => ModelSpec | undefined;
  getProvider: (id: string) => ModelProvider | undefined;
}

/** Validate a resolved profile against the provider roster. */
export function validateProfile(
  profile: Profile,
  registry: ProfileRegistry,
): ProfileValidationResult {
  const roleResults: ProfileRoleValidation[] = [];
  const errors: string[] = [];

  for (const role of KNOWN_ROLES) {
    const assignment = profile.roles[role];
    if (assignment === undefined) {
      // Missing role — only an error if it's required
      if ((REQUIRED_ROLES as readonly string[]).includes(role)) {
        errors.push(`Required role "${role}" is not defined in profile "${profile.name}"`);
        roleResults.push({
          role,
          provider: "(missing)",
          model: "(missing)",
          modelInRoster: false,
          providerReady: false,
          ok: false,
          error: `Required role "${role}" not defined`,
        });
      } else {
        roleResults.push({
          role,
          provider: "(not set)",
          model: "(not set)",
          modelInRoster: false,
          providerReady: false,
          ok: true, // optional roles don't block
        });
      }
      continue;
    }

    const modelSpec = registry.getModel(assignment.model);
    const modelInRoster = modelSpec !== undefined;
    const providerRegistered = registry.getProvider(assignment.provider) !== undefined;
    const providerReady = providerRegistered; // simplified — could check ready()

    const ok = modelInRoster && providerRegistered;
    if (!ok) {
      if (!modelInRoster) {
        errors.push(`Model "${assignment.model}" for role "${role}" is not in the provider roster`);
      }
      if (!providerRegistered) {
        errors.push(`Provider "${assignment.provider}" for role "${role}" is not registered`);
      }
    }

    roleResults.push({
      role,
      provider: assignment.provider,
      model: assignment.model,
      modelInRoster,
      providerReady,
      ok,
      error: ok ? undefined : `model=${modelInRoster ? "ok" : "missing"}, provider=${providerRegistered ? "ok" : "missing"}`,
    });
  }

  return {
    valid: errors.length === 0,
    profile: profile.name,
    roles: roleResults,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Default profiles
// ---------------------------------------------------------------------------

/** The built-in profiles that ship with ikbi. */
export const DEFAULT_PROFILES: Readonly<Record<string, Profile>> = Object.freeze({
  mimo: Object.freeze({
    name: "mimo",
    description: "MiMo family — cheapest workhorse. Good for daily use.",
    roles: {
      classifier: { provider: "mimo", model: "mimo-v2.5" },
      scout: { provider: "mimo", model: "mimo-v2.5" },
      builder: { provider: "mimo", model: "mimo-v2.5-pro" },
      critic: { provider: "mimo", model: "mimo-v2.5-pro" },
      fixer: { provider: "mimo", model: "mimo-v2.5-pro" },
      rescue: { provider: "mimo", model: "mimo-v2.5-pro" },
    },
    routing: {
      cheap_tier: "mimo",
      fallback_profile: "deepseek",
    },
    max_run_cost: 0.50,
  }),
  deepseek: Object.freeze({
    name: "deepseek",
    description: "DeepSeek family — good reasoning, moderate cost.",
    roles: {
      classifier: { provider: "deepseek", model: "deepseek-v4-flash" },
      scout: { provider: "deepseek", model: "deepseek-v4-flash" },
      builder: { provider: "deepseek", model: "deepseek-v4-pro" },
      critic: { provider: "deepseek", model: "deepseek-v4-pro" },
      fixer: { provider: "mimo", model: "mimo-v2.5-pro" },
      rescue: { provider: "mimo", model: "mimo-v2.5-pro" },
    },
    routing: {
      cheap_tier: "deepseek",
      fallback_profile: "mimo",
    },
    max_run_cost: 1.00,
  }),
  premium: Object.freeze({
    name: "premium",
    description: "Premium tier — strongest models for complex work.",
    extends: "mimo",
    roles: {
      builder: { provider: "openai", model: "gpt-4o" },
      critic: { provider: "anthropic", model: "claude-sonnet-4-5" },
    },
    routing: {
      cheap_tier: "mimo",
      fallback_profile: "deepseek",
    },
    max_run_cost: 5.00,
  }),
});

/**
 * Install default profiles to disk if they don't already exist.
 * Called on first use or during init.
 */
export async function installDefaultProfiles(stateRoot: string): Promise<number> {
  let installed = 0;
  for (const [name, profile] of Object.entries(DEFAULT_PROFILES)) {
    const path = profileFilePath(stateRoot, name);
    if (!existsSync(path)) {
      await saveProfile(stateRoot, profile);
      installed++;
    }
  }
  if (installed > 0) {
    log.info({ installed }, "installed default profiles");
  }
  return installed;
}

// ---------------------------------------------------------------------------
// Apply profile to environment
// ---------------------------------------------------------------------------

/**
 * Apply a profile's role assignments to environment variables.
 * This sets IKBI_MODEL_DRIVER, IKBI_MODEL_BUILDER, IKBI_MODEL_CRITIC, etc.
 * Returns the env vars that would be set (for display/testing).
 */
export function profileToEnv(profile: Profile): Record<string, string> {
  const env: Record<string, string> = {};
  if (profile.roles.classifier) {
    env.IKBI_MODEL_DRIVER = profile.roles.classifier.model;
  }
  if (profile.roles.builder) {
    env.IKBI_MODEL_BUILDER = profile.roles.builder.model;
  }
  if (profile.roles.critic) {
    env.IKBI_MODEL_CRITIC = profile.roles.critic.model;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Types for CLI
// ---------------------------------------------------------------------------

export interface ProfileSwitchResult {
  readonly success: boolean;
  readonly profile: string;
  readonly validation: ProfileValidationResult;
  readonly previousProfile: string | undefined;
}
