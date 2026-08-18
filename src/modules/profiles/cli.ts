/**
 * `ikbi profile` — manage model-strategy profiles.
 *
 * Commands:
 *   ikbi profile list              List available profiles
 *   ikbi profile show [name]       Show profile details
 *   ikbi profile use <name>        Switch to a profile (atomic, validates first)
 *   ikbi profile current           Show the active profile
 *   ikbi profile init              Install default profiles
 */

import { config } from "../../core/config.js";
import { registry } from "../../core/provider/index.js";
import { registerCommand } from "../../cli/registry.js";
import { writeStdout, writeStderr } from "../../cli/io.js";
import {
  listProfiles,
  loadProfile,
  resolveProfile,
  getActiveProfileName,
  getActiveProfile,
  switchProfile,
  clearActiveProfile,
  installDefaultProfiles,
  profileToEnv,
} from "./storage.js";
import { validateProfile } from "./storage.js";
import { KNOWN_ROLES, REQUIRED_ROLES } from "./contract.js";

const OK = "✓";
const BAD = "✗";
const WARN = "⚠";

export interface ProfileCliDeps {
  readonly stateRoot?: string;
  readonly out?: (s: string) => void;
  readonly err?: (s: string) => void;
}

export async function profileCli(
  argv: readonly string[],
  deps: ProfileCliDeps = {},
): Promise<number> {
  const stateRoot = deps.stateRoot ?? config.stateRoot;
  const out = deps.out ?? writeStdout;
  const err = deps.err ?? writeStderr;

  const subcommand = argv[0];

  switch (subcommand) {
    case "list":
      return profileList(stateRoot, out);
    case "show":
      return profileShow(stateRoot, argv[1], out, err);
    case "use":
      return profileUse(stateRoot, argv[1], out, err);
    case "current":
      return profileCurrent(stateRoot, out);
    case "init":
      return profileInit(stateRoot, out);
    case "clear":
      return profileClear(stateRoot, out);
    default:
      err(`Usage: ikbi profile <list|show|use|current|init|clear> [name]\n`);
      return 2;
  }
}

function profileList(stateRoot: string, out: (s: string) => void): number {
  const names = listProfiles(stateRoot);
  const active = getActiveProfileName(stateRoot);

  if (names.length === 0) {
    out("No profiles found. Run `ikbi profile init` to install defaults.\n");
    return 0;
  }

  out("PROFILES\n");
  for (const name of names) {
    const marker = name === active ? " (active)" : "";
    const profile = loadProfile(stateRoot, name);
    const desc = profile?.description ? ` — ${profile.description}` : "";
    out(`  ${name === active ? "●" : " "} ${name}${desc}${marker}\n`);
  }
  out("");
  return 0;
}

function profileShow(
  stateRoot: string,
  name: string | undefined,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  const target = name ?? getActiveProfileName(stateRoot);
  if (target === undefined) {
    err("No active profile. Usage: ikbi profile show [name]\n");
    return 2;
  }

  const profile = resolveProfile(stateRoot, target);
  if (profile === undefined) {
    err(`Profile "${target}" not found.\n`);
    return 1;
  }

  const active = getActiveProfileName(stateRoot);
  out(`PROFILE: ${profile.name}${profile.name === active ? " (active)" : ""}\n`);
  if (profile.description) out(`  ${profile.description}\n`);
  if (profile.extends) out(`  extends: ${profile.extends}\n`);
  if (profile.max_run_cost !== undefined) out(`  max_run_cost: $${profile.max_run_cost.toFixed(2)}\n`);
  out("\nROLES\n");

  for (const role of KNOWN_ROLES) {
    const assignment = profile.roles[role];
    const required = (REQUIRED_ROLES as readonly string[]).includes(role);
    if (assignment) {
      out(`  ${OK} ${role} [${required ? "required" : "optional"}] provider=${assignment.provider} model=${assignment.model}\n`);
    } else {
      out(`  ${required ? BAD : WARN} ${role} [${required ? "required" : "optional"}] (not set)\n`);
    }
  }

  // Validate against roster
  out("\nVALIDATION\n");
  const validation = validateProfile(profile, registry);
  for (const role of validation.roles) {
    out(`  ${role.ok ? OK : BAD} ${role.role}: ${role.model} — ${role.ok ? "ok" : role.error ?? "failed"}\n`);
  }
  if (validation.errors.length > 0) {
    out("\nERRORS\n");
    for (const error of validation.errors) {
      out(`  ${BAD} ${error}\n`);
    }
  }
  out(`\n${validation.valid ? "Profile is VALID" : "Profile has ERRORS"}\n`);

  if (profile.routing) {
    out("\nROUTING\n");
    if (profile.routing.cheap_tier) out(`  cheap_tier: ${profile.routing.cheap_tier}\n`);
    if (profile.routing.fallback_profile) out(`  fallback_profile: ${profile.routing.fallback_profile}\n`);
  }

  // Show env vars this profile would set
  out("\nENV VARS\n");
  const env = profileToEnv(profile);
  for (const [key, value] of Object.entries(env)) {
    out(`  ${key}=${value}\n`);
  }

  out("");
  return 0;
}

async function profileUse(
  stateRoot: string,
  name: string | undefined,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  if (name === undefined) {
    err("Usage: ikbi profile use <name>\n");
    return 2;
  }

  out(`Switching to profile "${name}"...\n\n`);

  const result = await switchProfile(stateRoot, name, registry);

  // Show validation results
  for (const role of result.validation.roles) {
    out(`  ${role.ok ? OK : BAD} ${role.role}: ${role.model} — ${role.ok ? "ok" : role.error ?? "failed"}\n`);
  }

  if (result.success) {
    out(`\n${OK} Active profile: ${name}`);
    if (result.previousProfile && result.previousProfile !== name) {
      out(` (was: ${result.previousProfile})`);
    }
    out("\n");

    // Show what env vars to set
    const profile = resolveProfile(stateRoot, name);
    if (profile) {
      const env = profileToEnv(profile);
      out("\nTo use in shell:\n");
      for (const [key, value] of Object.entries(env)) {
        out(`  export ${key}=${value}\n`);
      }
    }
    return 0;
  } else {
    out(`\n${BAD} Profile validation FAILED\n`);
    if (result.previousProfile) {
      out(`Active profile unchanged: ${result.previousProfile}\n`);
    } else {
      out("No active profile set.\n");
    }
    return 1;
  }
}

function profileCurrent(stateRoot: string, out: (s: string) => void): number {
  const name = getActiveProfileName(stateRoot);
  if (name === undefined) {
    out("No active profile. Using built-in defaults.\n");
    out("Run `ikbi profile init` to install default profiles, then `ikbi profile use <name>`.\n");
    return 0;
  }

  const profile = getActiveProfile(stateRoot);
  if (profile === undefined) {
    out(`Active profile pointer: "${name}" — but profile file not found!\n`);
    return 1;
  }

  out(`Active profile: ${name}\n`);
  if (profile.description) out(`  ${profile.description}\n`);
  if (profile.extends) out(`  extends: ${profile.extends}\n`);

  out("\nRoles:\n");
  for (const role of KNOWN_ROLES) {
    const assignment = profile.roles[role];
    if (assignment) {
      out(`  ${role}: ${assignment.provider}/${assignment.model}\n`);
    }
  }
  out("");
  return 0;
}

async function profileInit(stateRoot: string, out: (s: string) => void): Promise<number> {
  const installed = await installDefaultProfiles(stateRoot);
  if (installed > 0) {
    out(`Installed ${installed} default profile(s).\n`);
  } else {
    out("Default profiles already installed.\n");
  }

  const names = listProfiles(stateRoot);
  out("\nAvailable profiles:\n");
  for (const name of names) {
    const profile = loadProfile(stateRoot, name);
    const desc = profile?.description ? ` — ${profile.description}` : "";
    out(`  ${name}${desc}\n`);
  }
  out("\nUse `ikbi profile use <name>` to activate.\n");
  return 0;
}

async function profileClear(stateRoot: string, out: (s: string) => void): Promise<number> {
  const name = getActiveProfileName(stateRoot);
  if (name === undefined) {
    out("No active profile to clear.\n");
    return 0;
  }
  await clearActiveProfile(stateRoot);
  out(`Cleared active profile (was: ${name}). Using built-in defaults.\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Register the command
// ---------------------------------------------------------------------------

registerCommand({
  name: "profile",
  summary: "Manage model-strategy profiles (list, show, use, current, init, clear)",
  usage: "<list|show|use|current|init|clear> [name]",
  category: "advanced",
  run: async (argv) => {
    const exitCode = await profileCli(argv);
    if (exitCode !== 0) process.exitCode = exitCode;
  },
});
