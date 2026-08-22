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
import { executeV2BuildSession, type V2BuildSessionResult } from "../core/session.js";
import { buildCostBudgetPolicy, MICRO_USD_PER_USD, type CostBudgetPolicy, type PricingCatalog } from "../core/cost.js";
import { buildRecoveryPolicy, type RecoveryPolicy } from "../core/recovery.js";
import type { ContextSource } from "../core/context.js";
import type { InvocationTransport } from "../core/invocation.js";
import { PRODUCTION_CONTEXT_SOURCES } from "./context-sources.js";
import { createRetrievalSource } from "./retrieval-source.js";
import {
  builderBudgetWith,
  resolveBuilderCommands,
  resolveBuilderToolCalls,
  resolveBuilderTurns,
  BUILDER_COMMANDS_ENV,
  BUILDER_TOOL_CALLS_ENV,
  BUILDER_TURNS_ENV,
  type BuilderBoundSource,
  type BuilderBudget,
  type BuilderTurnSource,
} from "../core/builder.js";
import { createBuilderToolExecutor } from "./builder-tools.js";
import { captureCandidateTree } from "./candidate-capture.js";
import { createUntrustedBoundary } from "./untrusted-boundary.js";
import { createChecksSource, createVerificationDefinitionProbe } from "./verification-checks.js";
import { createCheckRunner } from "./check-runner.js";
import { createCommandCapability, createGovernedCommandTransport } from "./command-executor.js";
import { V2_DEFAULT_COMMAND_POLICY, type BuilderCommandCapability, type BuilderCommandPolicy } from "../core/command.js";
import { createTreeProbe } from "./verification-tree.js";
import { createCandidateDiffSource } from "./candidate-diff.js";
import { createCasPublicationTarget } from "./publication.js";

/**
 * STRICT integer env parse (V2-016A/L5). `parseInt("2junk")` is 2 — a partial parse that silently
 * accepts garbage. This requires the WHOLE trimmed value to be digits (optionally signed), so
 * `2junk`, `2.5`, `0x10` and `  ` are rejected (undefined) rather than mis-read.
 */
function strictInt(raw: string): number | undefined {
  const t = raw.trim();
  if (!/^-?\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The operator's per-check timeout knob, when set to a positive integer. */
function envCheckTimeoutMs(): number | undefined {
  const n = strictInt(process.env.IKBI_CHECK_TIMEOUT_MS ?? "");
  return n !== undefined && n > 0 ? n : undefined;
}

/**
 * The operator's recovery-attempt cap, read ONCE at session start (never between attempts).
 * `IKBI_RECOVERY_MAX_ATTEMPTS` overrides the safe default; anything not a clean integer is ignored.
 */
function envRecoveryMaxAttempts(): number | undefined {
  const n = strictInt(process.env.IKBI_RECOVERY_MAX_ATTEMPTS ?? "");
  return n !== undefined && n >= 1 ? n : undefined;
}

/**
 * The operator's BUILDER TURN BUDGET, read ONCE per session and frozen for all of it.
 *
 * REFUSES RATHER THAN IGNORING, unlike its siblings above. A cost cap that cannot be
 * parsed falls back toward LESS authority, so ignoring it is safe. This one falls back
 * toward less WORK: an operator who mistyped it would silently get twelve turns, watch the
 * build die at twelve, and conclude the model was incapable. That is the exact confusion
 * this knob exists to end, so a bad value stops the run here — before a provider is
 * called and before a workspace is allocated — with the reason said out loud.
 */
function envBuilderBudget(): {
  readonly budget: BuilderBudget;
  readonly turnSource: BuilderTurnSource;
  readonly toolCallSource: BuilderBoundSource;
  readonly commandSource: BuilderBoundSource;
} {
  const turns = resolveBuilderTurns(process.env[BUILDER_TURNS_ENV]);
  if (!turns.ok) throw new Error(`invalid builder turn budget: ${turns.reason}`);
  const tools = resolveBuilderToolCalls(process.env[BUILDER_TOOL_CALLS_ENV]);
  if (!tools.ok) throw new Error(`invalid builder tool-call budget: ${tools.reason}`);
  const commands = resolveBuilderCommands(process.env[BUILDER_COMMANDS_ENV]);
  if (!commands.ok) throw new Error(`invalid builder command budget: ${commands.reason}`);
  return {
    budget: builderBudgetWith({ maxTurns: turns.maxTurns, maxToolCalls: tools.value, maxCommands: commands.value }),
    turnSource: turns.source,
    toolCallSource: tools.source,
    commandSource: commands.source,
  };
}

/**
 * The operator's session COST BUDGET, read ONCE at session start (V2-014). Every ceiling is
 * OPT-IN — a default cap would be a hidden authority. `IKBI_V2_MAX_SESSION_COST_USD` sets a
 * whole-session dollar ceiling; `IKBI_V2_MAX_INVOCATIONS` caps model calls;
 * `IKBI_V2_COST_UNKNOWN=allow|stop|operator` chooses what happens when cost cannot be bounded
 * under a ceiling (default: operator-required). No ceiling ⇒ no policy (the safe no-cap default).
 */
function envCostBudgetPolicy(): CostBudgetPolicy | undefined {
  const usdRaw = (process.env.IKBI_V2_MAX_SESSION_COST_USD ?? "").trim();
  // L5: strict — a full decimal number for USD, a full integer for the invocation cap.
  const usd = /^\d+(\.\d+)?$/.test(usdRaw) ? Number(usdRaw) : NaN;
  const inv = strictInt(process.env.IKBI_V2_MAX_INVOCATIONS ?? "");
  const maxSessionCostMicroUsd = Number.isFinite(usd) && usd > 0 ? Math.round(usd * MICRO_USD_PER_USD) : undefined;
  const maxInvocations = inv !== undefined && inv >= 1 ? inv : undefined;
  if (maxSessionCostMicroUsd === undefined && maxInvocations === undefined) return undefined;
  const behaviorRaw = (process.env.IKBI_V2_COST_UNKNOWN ?? "").trim().toLowerCase();
  const behaviorWhenCostUnknown = behaviorRaw === "allow" ? "allow_unknown" : behaviorRaw === "stop" ? "stop_on_unknown" : "operator_required_on_unknown";
  return buildCostBudgetPolicy({
    ...(maxSessionCostMicroUsd !== undefined ? { maxSessionCostMicroUsd } : {}),
    ...(maxInvocations !== undefined ? { maxInvocations } : {}),
    behaviorWhenCostUnknown,
  });
}
import { createInvocationTransport, type TransportProviderLookup } from "./invocation-transport.js";
import { BOKAHLI_PROVIDER_ID, createBokahliProvider, type BokahliProviderConfig } from "./bokahli.js";
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
  /** Where an injected budget's turn count came from, for receipt truth. */
  readonly builderTurnSource?: V2RunDeps["builderTurnSource"];
  /** Where an injected budget's tool-call count came from, for receipt truth. */
  readonly builderToolCallSource?: V2RunDeps["builderToolCallSource"];
  /** Where an injected budget's command count came from, for receipt truth. */
  readonly builderCommandSource?: V2RunDeps["builderCommandSource"];
  readonly untrustedBoundary?: V2RunDeps["untrustedBoundary"];
  readonly checksSource?: V2RunDeps["checksSource"];
  readonly definitionProbe?: V2RunDeps["definitionProbe"];
  readonly checkRunner?: V2RunDeps["checkRunner"];
  readonly treeProbe?: V2RunDeps["treeProbe"];
  /** Test/override seam for the read-only command terminal (V2-015). */
  readonly commands?: BuilderCommandCapability;
  /** The frozen builder command policy (V2-015). Defaults to the shipped read-only allowlist. */
  readonly commandPolicy?: BuilderCommandPolicy;
  readonly checkTimeoutMs?: V2RunDeps["checkTimeoutMs"];
  readonly candidateDiff?: V2RunDeps["candidateDiff"];
  readonly publisher?: V2RunDeps["publisher"];
  /** The frozen recovery policy for a build session. Defaults to the safe development policy. */
  readonly recoveryPolicy?: RecoveryPolicy;
  /** The frozen session cost budget policy (V2-014). Defaults to the operator's env cap, or none. */
  readonly costBudgetPolicy?: CostBudgetPolicy;
  /** The frozen session pricing catalog (V2-014). Defaults to the shipped local catalog. */
  readonly pricingCatalog?: PricingCatalog;
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
      return createInvocationTransport(withBokahli(registry)).send(input);
    },
  };
}

/**
 * The provider lookup, with Bokahli resolvable by id.
 *
 * Bokahli is not built by the v1 registry and deliberately is not taught to it: its credential
 * comes from a mode-0600 FILE rather than a config value, and its routing policy (route mode,
 * task class, `requireQualified`, supervised-local) is a v2 concern the v1 roster has no place
 * to express. Teaching v1 about it would put a second, differently-configured way to reach the
 * same deployment into a layer v2 does not otherwise use.
 *
 * So the lookup is DECORATED rather than replaced: every existing provider resolves exactly as
 * before, and the single id `bokahli` resolves to the native v2 adapter. The lookup is still a
 * lookup — it chooses nothing, and a caller that did not resolve to this id never reaches it.
 *
 * Construction is LAZY and per-lookup on purpose: reading the credential at module load would
 * make every ikbi command fail on a machine that has no Bokahli, for a provider it was never
 * going to use. A missing or ill-permissioned credential surfaces when something actually asks
 * for Bokahli, which is when it is a real problem.
 */
function withBokahli(registry: TransportProviderLookup): TransportProviderLookup {
  return {
    getProvider(id: string) {
      if (id !== BOKAHLI_PROVIDER_ID) return registry.getProvider(id);
      return createBokahliProvider(readBokahliRuntimeConfig());
    },
  };
}

/**
 * Bokahli's per-run policy, from the operator environment.
 *
 * SUPERVISED-LOCAL IS OPT-IN AND EXPLICIT. It is never inferred from the endpoint being
 * loopback or tailnet: "local" says where inference happened, not that a human agreed to review
 * what came back. With neither variable set, an unqualified artifact is refused rather than
 * quietly accepted — which is the correct default for a deployment whose every artifact reports
 * INSTALLED_UNQUALIFIED.
 */
export function readBokahliRuntimeConfig(env: NodeJS.ProcessEnv = process.env): BokahliProviderConfig {
  const routeMode = (env["IKBI_BOKAHLI_ROUTE_MODE"] ?? "AUTO").toUpperCase();
  if (routeMode !== "AUTO" && routeMode !== "PROFILE" && routeMode !== "EXACT") {
    throw new Error(`IKBI_BOKAHLI_ROUTE_MODE must be AUTO, PROFILE or EXACT (got ${JSON.stringify(routeMode)})`);
  }
  const target = env["IKBI_BOKAHLI_TARGET"];
  const taskClass = env["IKBI_BOKAHLI_TASK_CLASS"];
  return {
    ...(env["IKBI_BOKAHLI_BASE_URL"] !== undefined ? { baseUrl: env["IKBI_BOKAHLI_BASE_URL"] } : {}),
    credentialFile: env["IKBI_BOKAHLI_TOKEN_FILE"] ?? `${env["HOME"] ?? ""}/.config/bokahli/token`,
    routeMode,
    ...(target !== undefined ? { target } : {}),
    ...(taskClass !== undefined ? { taskClass } : {}),
    requireQualified: env["IKBI_BOKAHLI_REQUIRE_QUALIFIED"] === "true",
    supervisedLocal: env["IKBI_BOKAHLI_SUPERVISED_LOCAL"] === "true",
  };
}

/**
 * Build the fully-wired single-attempt deps once, from the production defaults + any injected
 * overrides. Shared by the single-run entry and the session entry so both surfaces wire exactly
 * the same authorities.
 */
async function wireRunDeps(deps: ProductionRunDeps): Promise<V2RunDeps> {
  const complete = deps.workspaces !== undefined && deps.mutations !== undefined && deps.sources !== undefined;
  const wired = complete
    ? { workspaces: deps.workspaces!, mutations: deps.mutations!, sources: deps.sources! }
    : await productionAuthorities();
  const resolvedCheckTimeout = deps.checkTimeoutMs ?? envCheckTimeoutMs();
  /*
    THE BUILDER BUDGET, frozen here. `wireRunDeps` runs ONCE per build session, and the
    resulting deps are handed to every attempt the recovery authority composes — so the
    environment is read exactly once and a mid-run change to it cannot grant a session more
    builder authority than it started with. An injected budget (tests) still wins outright,
    and is recorded as the shipped default unless it says otherwise.
  */
  const resolved = deps.builderBudget !== undefined ? undefined : envBuilderBudget();
  const builderBudget = deps.builderBudget ?? resolved!.budget;
  const builderTurnSource: BuilderTurnSource = deps.builderTurnSource ?? resolved?.turnSource ?? "default";
  const builderToolCallSource: BuilderBoundSource = deps.builderToolCallSource ?? resolved?.toolCallSource ?? "default";
  const builderCommandSource: BuilderBoundSource = deps.builderCommandSource ?? resolved?.commandSource ?? "default";
  // The retrieval source is built PER RUN and is the reporter for that same run, so the
  // receipt can never describe a retrieval some other run performed.
  const retrieval = createRetrievalSource();
  const sources = deps.contextSources ?? [...PRODUCTION_CONTEXT_SOURCES, retrieval];
  // THE READ-ONLY command terminal (V2-015). One tree prober is shared with verification so the
  // command's before/after read-only proof uses the same authority. The command policy is frozen
  // (the shipped read-only allowlist unless a caller injects one). verifier is NEVER set here.
  const treeProbe = deps.treeProbe ?? createTreeProbe();
  const commandPolicy = deps.commandPolicy ?? V2_DEFAULT_COMMAND_POLICY;
  const commands = deps.commands ?? createCommandCapability({ transport: createGovernedCommandTransport(), treeProbe, policy: commandPolicy });
  return {
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
    // V2-016A/B4 — capture the source-truth verification definition so a candidate cannot rewrite its exam.
    definitionProbe: deps.definitionProbe ?? createVerificationDefinitionProbe(),
    checkRunner: deps.checkRunner ?? createCheckRunner(),
    treeProbe,
    commands,
    // THE candidate diff source for the critic — model-caused change vs the source snapshot.
    candidateDiff: deps.candidateDiff ?? createCandidateDiffSource(),
    // THE publication target — the ONLY thing that moves a target ref. Clean-ref CAS.
    publisher: deps.publisher ?? createCasPublicationTarget(),
    // Per-check timeout: an explicit override wins, else the operator's IKBI_CHECK_TIMEOUT_MS
    // (the donor's shared knob), else the run default. A hung check is killed and classified
    // as a timeout, never as an ordinary failure.
    ...(resolvedCheckTimeout !== undefined ? { checkTimeoutMs: resolvedCheckTimeout } : {}),
    builderBudget,
    builderTurnSource,
    builderToolCallSource,
    builderCommandSource,
    ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
  };
}

/** THE production single-attempt entry. One wiring, one configuration truth. */
export async function runV2BuildProduction(request: V2TaskRequest, deps: ProductionRunDeps = {}): Promise<V2RunResult> {
  return runV2Build(request, await wireRunDeps(deps));
}

/**
 * THE production BUILD SESSION entry every v2 surface uses. It wires the single-attempt deps
 * once and hands them to the session controller, which composes one OR MORE attempts under the
 * ONE recovery authority. A caller may inject a recovery policy; production uses the safe default.
 */
export async function runV2BuildSessionProduction(request: V2TaskRequest, deps: ProductionRunDeps = {}): Promise<V2BuildSessionResult> {
  const runDeps = await wireRunDeps(deps);
  // An explicit injected policy wins; otherwise the operator's env cap (read once) refines the
  // safe default. Nothing rereads it between attempts.
  const envMax = envRecoveryMaxAttempts();
  const recoveryPolicy = deps.recoveryPolicy ?? (envMax !== undefined ? buildRecoveryPolicy({ maxAttempts: envMax }) : undefined);
  // Same freeze discipline for the cost budget: an injected policy wins, else the operator's env
  // cap (read once), else no cap. The pricing catalog is the shipped constant unless injected.
  const costBudgetPolicy = deps.costBudgetPolicy ?? envCostBudgetPolicy();
  return executeV2BuildSession(request, {
    ...runDeps,
    ...(costBudgetPolicy !== undefined ? { costBudgetPolicy } : {}),
    ...(deps.pricingCatalog !== undefined ? { pricingCatalog: deps.pricingCatalog } : {}),
    ...(recoveryPolicy !== undefined ? { recoveryPolicy } : {}),
  });
}
