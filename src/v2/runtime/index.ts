/**
 * THE PRODUCTION WIRING of the v2 spine.
 *
 * `src/v2/core/` is pure and imports no v1 code, so it cannot construct its own
 * configuration source. This file is the one place that assembles the real one — v1's
 * provider registry, v1's profile files, v1's operator configuration — and the one
 * place a v2 surface should enter through. A second surface (server, REPL) added later
 * calls `runV2BuildProduction` and inherits exactly this configuration truth; wiring a
 * different source would be a visible edit here, not an accident somewhere else.
 *
 * WHY THE v1 IMPORTS ARE DYNAMIC: `core/config.js` and `core/provider/index.js` do real
 * work at module load — the config singleton validates trust keys and throws if they
 * are missing, and the provider singleton constructs every transport (which requires
 * the egress guard to already be installed). Importing them statically would make
 * merely LOADING the v2 CLI depend on that whole startup order, and would drag them
 * into tests that supply their own configuration source. Deferring the import to the
 * moment a run actually asks for configuration keeps v2 loadable on its own.
 */

import { readFileSync } from "node:fs";

import type { ConfigurationInputs, ConfigurationSource } from "../core/config.js";
import type { V2RunResult } from "../core/result.js";
import { runV2Build, type RepoProbe } from "../core/run.js";
import type { V2TaskRequest } from "../core/contract.js";
import { buildCanonicalCatalog } from "./model-catalog.js";
import { capabilityFacts } from "./provider-inventory.js";
import { readOperatorDefaults, readOperatorEnvPresence } from "./operator-defaults.js";
import { fileProfileStore, readActiveProfile, type ProfileStore } from "./profile-source.js";
import { readProviderInventory, type InventoryRegistry } from "./provider-inventory.js";

/** Everything the production source is built from. Overridable for hermetic tests. */
export interface ConfigurationSourceDeps {
  readonly registry?: InventoryRegistry;
  readonly profiles?: ProfileStore;
  readonly stateRoot?: string;
  readonly defaultModels?: { readonly driver: string; readonly builder: string; readonly critic: string };
  readonly rosterFile?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Model ids the operator's roster file DECLARES. Read independently of the registry
 * because the registry merges every source into one map, losing which entries were
 * declared and which were synthesized. A declared id is always real, whatever any
 * preference happens to be set to.
 */
export function rosterDeclaredIds(rosterFile: string): readonly string[] {
  try {
    const doc = JSON.parse(readFileSync(rosterFile, "utf8")) as { models?: readonly { id?: unknown }[] };
    if (!Array.isArray(doc.models)) return [];
    return doc.models.map((m) => m?.id).filter((id): id is string => typeof id === "string");
  } catch {
    // Absent or unreadable: v1 already fails loudly at startup for a malformed roster,
    // so by the time v2 runs an unreadable file means there is no roster to declare from.
    return [];
  }
}

/** The v1 facts the production source needs, loaded on first use. */
async function v1Facts(deps: ConfigurationSourceDeps): Promise<{
  registry: InventoryRegistry;
  profiles: ProfileStore;
  defaultModels: { driver: string; builder: string; critic: string };
  rosterFile: string;
}> {
  const needsRegistry = deps.registry === undefined;
  const needsConfig = deps.stateRoot === undefined || deps.defaultModels === undefined || deps.rosterFile === undefined;
  const [providerModule, configModule] = await Promise.all([
    needsRegistry ? import("../../core/provider/index.js") : Promise.resolve(undefined),
    needsConfig ? import("../../core/config.js") : Promise.resolve(undefined),
  ]);
  const stateRoot = deps.stateRoot ?? configModule!.config.stateRoot;
  return {
    registry: deps.registry ?? providerModule!.registry,
    profiles: deps.profiles ?? fileProfileStore(stateRoot),
    defaultModels: deps.defaultModels ?? configModule!.config.provider.defaultModels,
    rosterFile: deps.rosterFile ?? configModule!.config.provider.rosterFile,
  };
}

/**
 * Build THE configuration source.
 *
 * Everything it does is a read: list what the registry already holds, stat and parse
 * the selected profile file, and note which tier env vars are set. No network, no
 * model invocation, no write — reading configuration is not using it.
 */
export function createConfigurationSource(deps: ConfigurationSourceDeps = {}): ConfigurationSource {
  return {
    async load(request): Promise<ConfigurationInputs> {
      const facts = await v1Facts(deps);
      // INVENTORY IS FACT. The catalog is COMPOSED from declarative sources — shipped
      // built-ins, provider auto-discovery, and the operator's declared roster — rather
      // than read out of v1's assembled model map, which a preference has already
      // contaminated by the time anyone can look at it. See model-catalog.ts.
      const observed = readProviderInventory(facts.registry);
      const declared = new Set(rosterDeclaredIds(facts.rosterFile));
      const inventory = buildCanonicalCatalog({
        providers: observed.providers,
        rosterModels: observed.models.filter((model) => declared.has(model.id)),
        capabilitiesFor: (modelId) => capabilityFacts(modelId),
      });
      return {
        inventory,
        activeProfile: readActiveProfile(facts.profiles, request.profileOverride),
        operatorDefaults: readOperatorDefaults(facts.defaultModels, readOperatorEnvPresence(deps.env ?? process.env)),
      };
    },
  };
}

/** Optional overrides a caller may pass through to the canonical run. */
export interface ProductionRunDeps {
  readonly configuration?: ConfigurationSource;
  readonly probe?: RepoProbe;
}

/** THE production entry every v2 surface uses. One wiring, one configuration truth. */
export async function runV2BuildProduction(request: V2TaskRequest, deps: ProductionRunDeps = {}): Promise<V2RunResult> {
  return runV2Build(request, {
    configuration: deps.configuration ?? createConfigurationSource(),
    ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
  });
}
