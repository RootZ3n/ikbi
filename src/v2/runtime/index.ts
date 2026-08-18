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
import { runV2Build, type RepoProbe , type V2RunDeps } from "../core/run.js";
import type { ContextSource } from "../core/context.js";
import type { InvocationTransport } from "../core/invocation.js";
import { PRODUCTION_CONTEXT_SOURCES } from "./context-sources.js";
import { createRetrievalSource } from "./retrieval-source.js";
import { createBuilderToolExecutor } from "./builder-tools.js";
import { captureCandidateTree } from "./candidate-capture.js";
import { createUntrustedBoundary } from "./untrusted-boundary.js";
import { createChecksSource } from "./verification-checks.js";
import { createCheckRunner } from "./check-runner.js";
import { createTreeProbe } from "./verification-tree.js";

/** The operator's per-check timeout knob, when set to a positive integer. */
function envCheckTimeoutMs(): number | undefined {
  const raw = (process.env.IKBI_CHECK_TIMEOUT_MS ?? "").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
import { createInvocationTransport } from "./invocation-transport.js";
import { createProductionWorkspaceAuthorities } from "./workspace-authority.js";
import { createSourceSnapshotAuthority } from "./source-snapshot.js";
import type { StateBoundMutationAuthority, WorkspaceAuthority } from "../core/workspace.js";
import type { SourceSnapshotAuthority } from "../core/source.js";
import { createIdFactory } from "../core/identity.js";
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
  readonly contextSources?: readonly ContextSource[];
  /** Test seams. Production uses the canonical executor and git tree capture. */
  readonly buildTools?: V2RunDeps["buildTools"];
  readonly captureTree?: V2RunDeps["captureTree"];
  readonly builderBudget?: V2RunDeps["builderBudget"];
  readonly untrustedBoundary?: V2RunDeps["untrustedBoundary"];
  readonly checksSource?: V2RunDeps["checksSource"];
  readonly checkRunner?: V2RunDeps["checkRunner"];
  readonly treeProbe?: V2RunDeps["treeProbe"];
  readonly checkTimeoutMs?: V2RunDeps["checkTimeoutMs"];
  readonly transport?: InvocationTransport;
  readonly workspaces?: WorkspaceAuthority;
  readonly mutations?: StateBoundMutationAuthority;
  readonly sources?: SourceSnapshotAuthority;
  readonly probe?: RepoProbe;
}

/**
 * THE production workspace + state-bound mutation authorities, over v1's workspace
 * manager singleton. Imported dynamically for the same reason the provider registry is:
 * the module constructs durable stores at load.
 *
 * Both authorities are built together and share one handle table — a mutation cannot be
 * performed in a workspace this process did not allocate.
 */
async function productionAuthorities(): Promise<{
  workspaces: WorkspaceAuthority;
  mutations: StateBoundMutationAuthority;
  sources: SourceSnapshotAuthority;
}> {
  const { workspaces: manager } = await import("../../core/workspace/index.js");
  const ids = createIdFactory();
  // ONE snapshot authority per run assembly: the workspace authority materializes from
  // the very bytes it captured, so context and the candidate cannot disagree.
  const sources = createSourceSnapshotAuthority();
  const built = createProductionWorkspaceAuthorities({
    manager,
    mintWorkspaceId: () => ids.mint("workspace"),
    capturedBytes: (snapshotId) => sources.capturedBytes(snapshotId),
  });
  return { ...built, sources };
}

/**
 * THE production transport. Deliberately built over the v1 provider REGISTRY only as a
 * lookup — `getProvider(id)` — never as a router: the route was decided by the resolver,
 * and `ProviderInvoker` (v1's fallback/retry/circuit-breaker path) is not in the picture.
 *
 * The registry import is dynamic for the same reason the configuration source's is: it
 * constructs every transport at module load and needs the egress guard installed first.
 */
export function productionTransport(): InvocationTransport {
  return {
    async send(input) {
      const { registry } = await import("../../core/provider/index.js");
      return createInvocationTransport(registry).send(input);
    },
  };
}

/** THE production entry every v2 surface uses. One wiring, one configuration truth. */
export async function runV2BuildProduction(request: V2TaskRequest, deps: ProductionRunDeps = {}): Promise<V2RunResult> {
  const complete = deps.workspaces !== undefined && deps.mutations !== undefined && deps.sources !== undefined;
  const wired = complete
    ? { workspaces: deps.workspaces!, mutations: deps.mutations!, sources: deps.sources! }
    : await productionAuthorities();
  const resolvedCheckTimeout = deps.checkTimeoutMs ?? envCheckTimeoutMs();
  // The retrieval source is built PER RUN and is the reporter for that same run, so the
  // receipt can never describe a retrieval some other run performed.
  const retrieval = createRetrievalSource();
  const sources = deps.contextSources ?? [...PRODUCTION_CONTEXT_SOURCES, retrieval];
  return runV2Build(request, {
    workspaces: deps.workspaces ?? wired.workspaces,
    mutations: deps.mutations ?? wired.mutations,
    sources: deps.sources ?? wired.sources,
    configuration: deps.configuration ?? createConfigurationSource(),
    contextSources: sources,
    // Reported only when the run is actually using the production source list: a caller
    // that injected its own sources gets no retrieval claim it did not earn.
    ...(deps.contextSources === undefined ? { retrieval } : {}),
    transport: deps.transport ?? productionTransport(),
    // THE BUILDER'S CAPABILITY, wired once. The controller is handed an executor it
    // cannot construct and a tree-capture it cannot perform, so neither the loop nor the
    // model is ever holding the authority itself.
    buildTools: deps.buildTools ?? createBuilderToolExecutor,
    captureTree: deps.captureTree ?? captureCandidateTree,
    // THE untrusted-data boundary — v1's neutralization fence. Every tool result crosses
    // it before re-entering the builder conversation.
    untrustedBoundary: deps.untrustedBoundary ?? createUntrustedBoundary(),
    // THE deterministic verification seams — check discovery, governed execution, and the
    // git tree probe. All three do I/O, so they are wired here, once.
    checksSource: deps.checksSource ?? createChecksSource(),
    checkRunner: deps.checkRunner ?? createCheckRunner(),
    treeProbe: deps.treeProbe ?? createTreeProbe(),
    // Per-check timeout: an explicit override wins, else the operator's IKBI_CHECK_TIMEOUT_MS
    // (the donor's shared knob), else the run default. A hung check is killed and classified
    // as a timeout, never as an ordinary failure.
    ...(resolvedCheckTimeout !== undefined ? { checkTimeoutMs: resolvedCheckTimeout } : {}),
    ...(deps.builderBudget !== undefined ? { builderBudget: deps.builderBudget } : {}),
    ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
  });
}
