/**
 * ADAPTER — v1 profile storage → v2 active-profile facts.
 *
 * THE DEFECT THIS EXISTS TO FIX: in v1, `ikbi profile use <name>` writes an
 * active-profile pointer and then prints `export IKBI_MODEL_*` instructions. Nothing
 * on any build path reads that pointer (verified: no consumer of `getActiveProfile`,
 * `resolveProfile` or the pointer file exists outside `src/modules/profiles/`). The
 * profile system was, in production terms, a documentation generator. This adapter
 * makes the pointer an actual runtime input.
 *
 * WHY INHERITANCE IS RESOLVED HERE rather than by calling v1's `resolveProfile`:
 * v1 degrades silently in two ways this boundary cannot accept — a missing parent is
 * logged and the child is used WITHOUT inheritance, and an over-deep chain returns
 * `undefined` (indistinguishable from "no such profile"). v2 must fail truthfully
 * instead, so it walks the chain itself using v1's `loadProfile` primitive and mirrors
 * v1's merge semantics exactly. A test pins that equivalence for the healthy case.
 *
 * This adapter never writes. Activation stays entirely v1's `ikbi profile use`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Profile } from "../../modules/profiles/contract.js";
import { loadProfile, profilesDir } from "../../modules/profiles/storage.js";
import { getActiveProfileName } from "../../modules/profiles/storage.js";
import type {
  ActiveProfileInput,
  ProfileResolutionErrorCode,
  ProfileSource,
  ResolvedProfileInput,
} from "../core/config.js";

/** Inheritance depth ceiling. Matches v1's limit so a chain v1 accepts, v2 accepts. */
export const MAX_INHERITANCE_DEPTH = 6;

/** A profile name must be a plain file stem — never a path. Guards the read against traversal. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The v1 read primitives this adapter uses. Injected so tests need no real filesystem. */
export interface ProfileStore {
  activeName(): string | undefined;
  load(name: string): Profile | undefined;
  exists(name: string): boolean;
}

/** The production store: v1's profile files under a state root. Read-only. */
export function fileProfileStore(stateRoot: string): ProfileStore {
  return {
    activeName: () => getActiveProfileName(stateRoot),
    load: (name) => loadProfile(stateRoot, name),
    exists: (name) => existsSync(join(profilesDir(stateRoot), `${name}.json`)),
  };
}

/**
 * Resolve the profile that applies to this run.
 *
 * An override wins over the standing pointer; absence of both is `none`, which is a
 * normal state and not a failure. Anything the operator DID select and that cannot be
 * resolved becomes `unresolvable` — never a quiet substitution.
 */
export function readActiveProfile(store: ProfileStore, override?: string): ActiveProfileInput {
  const overrideName = override?.trim();
  if (overrideName !== undefined && overrideName.length > 0) {
    return resolveChain(store, overrideName, "run_override");
  }
  const active = store.activeName();
  if (active === undefined || active.length === 0) return { kind: "none" };
  return resolveChain(store, active, "active_pointer");
}

function unresolvable(
  name: string,
  source: ProfileSource,
  code: ProfileResolutionErrorCode,
  detail: string,
): ActiveProfileInput {
  return { kind: "unresolvable", name, source, code, detail };
}

/** Walk the `extends` chain child-first, then fold it root-first. Fails loudly. */
function resolveChain(store: ProfileStore, name: string, source: ProfileSource): ActiveProfileInput {
  const chain: string[] = [];
  const layers: Profile[] = [];
  const seen = new Set<string>();
  let current: string | undefined = name;

  while (current !== undefined) {
    if (!PROFILE_NAME.test(current)) {
      return unresolvable(name, source, "profile_name_invalid", `"${current}" is not a valid profile name`);
    }
    if (seen.has(current)) {
      return unresolvable(name, source, "profile_inheritance_cycle", `"${current}" appears twice in the extends chain [${chain.join(" -> ")}]`);
    }
    if (chain.length >= MAX_INHERITANCE_DEPTH) {
      return unresolvable(name, source, "profile_inheritance_too_deep", `the extends chain exceeds ${MAX_INHERITANCE_DEPTH} levels: [${chain.join(" -> ")}]`);
    }
    seen.add(current);
    chain.push(current);

    const loaded: Profile | undefined = store.load(current);
    if (loaded === undefined) {
      // v1's loader returns undefined for BOTH "no file" and "bad file". Distinguish
      // them here so the operator is told which problem they actually have.
      if (store.exists(current)) {
        return unresolvable(name, source, "profile_malformed", `profile file "${current}.json" exists but is not readable/valid JSON`);
      }
      return chain.length === 1
        ? unresolvable(name, source, "profile_not_found", `no profile named "${current}"`)
        : unresolvable(name, source, "profile_parent_not_found", `"${chain[chain.length - 2] ?? name}" extends "${current}", which does not exist`);
    }
    layers.push(loaded);
    current = loaded.extends;
  }

  return { kind: "resolved", profile: fold(name, chain, layers, source) };
}

/**
 * Fold the chain root-first. Mirrors v1's merge: later (more derived) layers override,
 * with `roles`, `routing` and `parameters` shallow-merged per key rather than replaced.
 */
function fold(name: string, chain: readonly string[], layers: readonly Profile[], source: ProfileSource): ResolvedProfileInput {
  let roles: Record<string, { provider: string; model: string }> = {};
  let parameters: Record<string, unknown> = {};
  let cheapTier: string | undefined;
  let fallbackProfile: string | undefined;
  let description: string | undefined;
  let maxRunCostUsd: number | undefined;

  for (const layer of [...layers].reverse()) {
    roles = { ...roles, ...(layer.roles ?? {}) };
    parameters = { ...parameters, ...(layer.parameters ?? {}) };
    if (layer.routing?.cheap_tier !== undefined) cheapTier = layer.routing.cheap_tier;
    if (layer.routing?.fallback_profile !== undefined) fallbackProfile = layer.routing.fallback_profile;
    if (layer.description !== undefined) description = layer.description;
    if (layer.max_run_cost !== undefined) maxRunCostUsd = layer.max_run_cost;
  }

  const routing =
    cheapTier !== undefined || fallbackProfile !== undefined
      ? {
          ...(cheapTier !== undefined ? { cheapTier } : {}),
          ...(fallbackProfile !== undefined ? { fallbackProfile } : {}),
        }
      : undefined;

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inheritanceChain: chain,
    roles,
    ...(routing !== undefined ? { routing } : {}),
    parameters,
    ...(maxRunCostUsd !== undefined ? { maxRunCostUsd } : {}),
    source,
  };
}
