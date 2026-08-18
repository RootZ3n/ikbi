/**
 * ikbi v2 — THE CONFIGURATION TRUTH BOUNDARY.
 *
 * Three questions, three owners, one output:
 *
 *   PROVIDER INVENTORY  what CAN this machine invoke?
 *   ACTIVE PROFILE      what strategy does the operator WANT?
 *   RUNTIME MODEL POLICY  what validated policy does the model resolver get?
 *
 * Everything in this file is PURE. It takes plain observed facts as input and
 * returns an immutable, content-addressed policy. It reads no file, no environment
 * variable, no singleton, and imports nothing from v1 — the adapters in
 * `src/v2/runtime/` do the observing, and they are the only place that knows v1
 * exists. That split is what makes "exactly one configuration input" enforceable:
 * V2-003's resolver receives a `RuntimeModelPolicy` and has nowhere else to look.
 *
 * WHAT THIS LAYER DOES NOT DO:
 *   - it does not select a model for a task (that is V2-003)
 *   - it does not invoke anything, including a probe that costs tokens
 *   - it does not claim a provider is REACHABLE — only how it is CONFIGURED
 *   - it does not carry credential material, in any field, ever
 */

import {
  contentDigest,
  type V2InventoryDigest,
  type V2PolicyDigest,
  type V2ProfileDigest,
} from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * The canonical model roles. Mirrors v1's `KNOWN_ROLES` deliberately — v2 declares
 * its own copy so this file stays free of v1 imports, and a runtime test asserts the
 * two lists have not drifted apart.
 */
export const V2_MODEL_ROLES = [
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

export type V2ModelRole = (typeof V2_MODEL_ROLES)[number];

/** Roles without which a build cannot proceed. Mirrors v1's `REQUIRED_ROLES`. */
export const V2_REQUIRED_ROLES: readonly V2ModelRole[] = ["builder", "critic"];

/** Runtime guard: is `s` a canonical model role? */
export function isV2ModelRole(s: string): s is V2ModelRole {
  return (V2_MODEL_ROLES as readonly string[]).includes(s);
}

/**
 * How v1's three configured model TIERS map onto v2's roles.
 *
 * v1 resolves `driver`/`builder`/`critic` from config and then aliases them at the
 * use site (`role-models.ts` sends the scout at the driver tier; `profileToEnv` maps a
 * profile's `classifier` onto `IKBI_MODEL_DRIVER`). v2 makes that mapping explicit
 * data instead of scattered convention, so the operator-config layer lands on named
 * roles rather than on a tier vocabulary only some call sites understand.
 */
export const OPERATOR_TIER_ROLES: Readonly<Record<OperatorTier, readonly V2ModelRole[]>> = {
  driver: ["classifier", "scout"],
  builder: ["builder"],
  critic: ["critic"],
};

export type OperatorTier = "driver" | "builder" | "critic";

// ---------------------------------------------------------------------------
// Inputs — plain observed facts, produced by src/v2/runtime adapters
// ---------------------------------------------------------------------------

/**
 * Non-secret facts about one registered provider. There is deliberately no field
 * that could hold a key: an adapter cannot leak a credential through this type even
 * by accident, because the type has nowhere to put one.
 */
export interface ProviderFactsInput {
  readonly id: string;
  /**
   * Did the provider expose read-only preflight metadata? When false, v2 does NOT
   * guess: readiness becomes "unknown" rather than an optimistic "configured". An
   * older or hand-rolled provider that cannot describe itself must not be reported as
   * ready on the strength of being registered.
   */
  readonly introspectable: boolean;
  readonly kind: string;
  /** Endpoint, with any URL userinfo already stripped by the adapter. */
  readonly baseUrl: string;
  readonly credentialRequired: boolean;
  readonly credentialPresent: boolean;
  /** A non-secret LABEL for where a credential came from (e.g. "environment"). Never a value. */
  readonly credentialSource?: string;
  /** A non-secret label for where the provider was configured (e.g. a roster path). */
  readonly configurationSource?: string;
}

/** One route in a model's ordered fallback chain. */
export interface ModelRouteInput {
  readonly providerId: string;
  readonly providerModelId: string;
}

/**
 * Static capability facts for one model, with their PROVENANCE.
 *
 * v2 publishes these only when they are actually known: `declared` means the operator's
 * roster states them, `known` means v1's classification table matched the model id. A
 * model that matches neither carries NO facts at all — v1 falls back to a conservative
 * 8k/no-tools profile for such ids, and republishing that guess as a fact is precisely
 * the "invented capability data" the resolver must never act on.
 */
export interface ModelCapabilityFacts {
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly supportsThinking?: boolean;
  readonly reasoningLevel: "low" | "medium" | "high";
  readonly speedClass: "fast" | "medium" | "slow";
  readonly provenance: "declared" | "known";
}

/** A model as the roster declares it. */
export interface ModelFactsInput {
  readonly id: string;
  readonly role?: string;
  readonly routes: readonly ModelRouteInput[];
  /** Omitted when the model is unclassified and the roster declares nothing. */
  readonly capabilities?: ModelCapabilityFacts;
}

/** Everything an adapter observed about what this machine can invoke. */
export interface ProviderInventoryInput {
  readonly providers: readonly ProviderFactsInput[];
  readonly models: readonly ModelFactsInput[];
}

/** Why an explicitly selected profile could not be resolved. Closed set. */
export type ProfileResolutionErrorCode =
  | "profile_name_invalid"
  | "profile_not_found"
  | "profile_unreadable"
  | "profile_malformed"
  | "profile_parent_not_found"
  | "profile_inheritance_cycle"
  | "profile_inheritance_too_deep";

/** Where an active profile selection came from. */
export type ProfileSource = "run_override" | "active_pointer";

/** A profile after inheritance has been resolved, as observed by the adapter. */
export interface ResolvedProfileInput {
  readonly name: string;
  readonly description?: string;
  /** The `extends` chain, child first, root last. `[name]` when nothing is inherited. */
  readonly inheritanceChain: readonly string[];
  readonly roles: Readonly<Record<string, { readonly provider: string; readonly model: string }>>;
  readonly routing?: { readonly cheapTier?: string; readonly fallbackProfile?: string };
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly maxRunCostUsd?: number;
  readonly source: ProfileSource;
}

/**
 * What the adapter found when it looked for an active profile.
 *
 * `none` and `unresolvable` are DIFFERENT and must never be collapsed: "the operator
 * selected nothing" is a normal state, while "the operator selected something and it
 * is broken" must fail the run rather than quietly degrade to a different strategy.
 */
export type ActiveProfileInput =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly profile: ResolvedProfileInput }
  | {
      readonly kind: "unresolvable";
      readonly name: string;
      readonly source: ProfileSource;
      readonly code: ProfileResolutionErrorCode;
      readonly detail: string;
    };

/** One operator-configured default model tier. */
export interface OperatorDefaultInput {
  readonly tier: OperatorTier;
  readonly modelId: string;
  /** True when the operator set it explicitly (env); false when it is a built-in default. */
  readonly explicit: boolean;
}

/** The operator/provider configuration layer — below profiles in precedence. */
export interface OperatorDefaultsInput {
  readonly models: readonly OperatorDefaultInput[];
}

/** Everything the configuration boundary needs, all of it already observed. */
export interface ConfigurationInputs {
  readonly inventory: ProviderInventoryInput;
  readonly activeProfile: ActiveProfileInput;
  readonly operatorDefaults: OperatorDefaultsInput;
}

/**
 * The seam a v2 surface uses to obtain configuration facts. One production impl.
 *
 * ASYNC on purpose. It lets the production source defer loading v1's provider layer
 * until a run actually asks for configuration, which keeps the v2 CLI module free of
 * v1's construct-at-import provider singleton — so a test with a fake source never
 * drags the real one into the process.
 */
export interface ConfigurationSource {
  load(request: { readonly profileOverride?: string }): Promise<ConfigurationInputs>;
}

// ---------------------------------------------------------------------------
// Normalized output
// ---------------------------------------------------------------------------

/**
 * How a provider is CONFIGURED. Note what is absent: there is no `reachable`.
 * A present API key is not evidence that a network call would succeed, and v2 will
 * not let a later layer read one as the other.
 */
export type ProviderReadiness = "configured" | "keyless" | "not_configured" | "unknown";

/** A provider, normalized. Non-secret by construction. */
export interface ProviderIdentity {
  readonly id: string;
  readonly kind: string;
  readonly baseUrl: string;
  readonly readiness: ProviderReadiness;
  readonly credentialRequired: boolean;
  readonly credentialPresent: boolean;
  readonly credentialSource?: string;
  readonly configurationSource?: string;
}

/** A model route, with the readiness of the provider it points at. */
export interface ModelRoute {
  readonly providerId: string;
  readonly providerModelId: string;
  readonly providerRegistered: boolean;
  readonly providerReadiness: ProviderReadiness;
}

/** A model this machine knows about, and how usable its routes are. */
export interface AvailableModel {
  /** The LOGICAL roster id a profile or an operator default names. */
  readonly id: string;
  readonly role?: string;
  /** Static facts the resolver may evaluate requirements against. Absent when unknown. */
  readonly capabilities?: ModelCapabilityFacts;
  /** The ordered fallback chain. Order is semantic and preserved. */
  readonly routes: readonly ModelRoute[];
  /** At least one route points at a REGISTERED provider. */
  readonly routable: boolean;
  /** At least one route points at a provider that is configured or keyless. */
  readonly invocable: boolean;
}

/** The canonical answer to "what can this machine invoke?". */
export interface ProviderInventory {
  readonly digest: V2InventoryDigest;
  /** Sorted by id. */
  readonly providers: readonly ProviderIdentity[];
  /** Sorted by id. */
  readonly models: readonly AvailableModel[];
  readonly providersConfigured: number;
  readonly modelsInvocable: number;
}

/** One role preference a profile declares. */
export interface ProfileRolePreference {
  readonly role: V2ModelRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly required: boolean;
}

/** The active profile, normalized. Credential-ish parameter values are redacted. */
export interface ActiveModelProfile {
  readonly name: string;
  readonly digest: V2ProfileDigest;
  readonly description?: string;
  readonly inheritanceChain: readonly string[];
  readonly rolePreferences: readonly ProfileRolePreference[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly source: ProfileSource;
}

/** Where one resolved preference came from. This IS the precedence record. */
export type RolePreferenceSource = "run_override" | "active_profile" | "operator_env" | "builtin_default";

/** A role preference after precedence resolution and availability checking. */
export interface ResolvedRolePreference {
  readonly role: V2ModelRole;
  readonly modelId: string;
  /** Present when the source names a provider. Operator defaults leave routing to the roster. */
  readonly providerId?: string;
  readonly source: RolePreferenceSource;
  readonly required: boolean;
  readonly modelInInventory: boolean;
  readonly providerRegistered: boolean;
  /** Present only when the preference PINS a provider. Absent means none was chosen yet. */
  readonly providerReadiness?: ProviderReadiness;
  /** Structurally sound AND backed by a provider that is configured or keyless. */
  readonly satisfiable: boolean;
}

/** Policy-level constraints a profile declares. Not routing decisions. */
export interface PolicyConstraints {
  readonly maxRunCostUsd?: number;
  readonly cheapTier?: string;
  readonly fallbackProfile?: string;
}

/**
 * THE single normalized configuration input for every future model decision.
 *
 * Immutable once built (deep-frozen). Content-addressed: `policyId` changes when the
 * configuration changes and stays put when it does not.
 */
export interface RuntimeModelPolicy {
  readonly policyId: V2PolicyDigest;
  readonly profile?: ActiveModelProfile;
  readonly profileSource: RolePreferenceSource | "none";
  readonly inventory: ProviderInventory;
  /** Sorted by role. One entry per role that ANY layer expressed a preference for. */
  readonly rolePreferences: readonly ResolvedRolePreference[];
  readonly constraints: PolicyConstraints;
  /** Required roles that exist but cannot currently be invoked. Truth, not a verdict. */
  readonly unsatisfiableRequiredRoles: readonly V2ModelRole[];
}

/** Building a policy either succeeds or fails with a structured, reportable reason. */
export type PolicyResult =
  | { readonly ok: true; readonly policy: RuntimeModelPolicy }
  | { readonly ok: false; readonly failure: RunFailure };

// ---------------------------------------------------------------------------
// Failure codes
// ---------------------------------------------------------------------------

/** Configuration failures this slice can produce. */
export const V2_CONFIG_FAILURE_CODES = {
  profileUnresolvable: "preflight.active_profile_unresolvable",
  profileMissingRequiredRole: "preflight.profile_missing_required_role",
  profileUnknownRole: "preflight.profile_unknown_role",
  profileModelNotInInventory: "preflight.profile_model_not_in_inventory",
  profileProviderNotRegistered: "preflight.profile_provider_not_registered",
} as const;

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

/** Parameter keys whose VALUES are replaced before a profile enters the policy. */
const CREDENTIALISH_KEY = /(api[-_ ]?key|secret|token|password|passwd|bearer|credential|authorization|auth)/i;

/** The stand-in written in place of a redacted value. Never a partial reveal. */
export const REDACTED = "[redacted]";

/**
 * Strip credential-ish values out of operator-authored free-form data.
 *
 * A profile's `parameters` map is whatever the operator put in the file, and this
 * layer's output is printed, hashed and receipted. Rather than trusting that nobody
 * ever pastes a key there, v2 redacts by key name on the way in — so a leak would
 * require a credential stored under a name that looks like nothing of the sort.
 */
export function redactParameters(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactRecord(value, 0);
}

function redactRecord(value: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const raw = value[key];
    if (CREDENTIALISH_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(raw, depth + 1);
  }
  return out;
}

function redactValue(raw: unknown, depth: number): unknown {
  // A deeply nested structure is dropped rather than walked forever; configuration
  // parameters are meant to be shallow, and an unbounded walk is a DoS surface.
  if (depth > 6) return REDACTED;
  if (Array.isArray(raw)) return raw.map((item) => redactValue(item, depth + 1));
  if (typeof raw === "object" && raw !== null) return redactRecord(raw as Record<string, unknown>, depth);
  return raw;
}

/** Remove `user:pass@` from a URL so an endpoint can be printed safely. */
export function redactUrlUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // Not a parseable URL — strip anything before an `@` in the authority position.
    return url.replace(/^([a-zA-Z][\w+.-]*:\/\/)[^/@]*@/, `$1${REDACTED}@`);
  }
}

// ---------------------------------------------------------------------------
// Inventory normalization
// ---------------------------------------------------------------------------

/** Classify one provider's configuration state. Never claims reachability. */
export function readinessOf(facts: ProviderFactsInput): ProviderReadiness {
  if (!facts.introspectable) return "unknown";
  if (!facts.credentialRequired) return "keyless";
  return facts.credentialPresent ? "configured" : "not_configured";
}

/** A readiness that permits an invocation attempt. Not a promise that one succeeds. */
export function isUsableReadiness(readiness: ProviderReadiness): boolean {
  return readiness === "configured" || readiness === "keyless";
}

/**
 * Normalize observed provider/model facts into the canonical inventory.
 *
 * Providers and models are SORTED (their collection order carries no meaning), while
 * each model's routes keep their declared order (a fallback chain is ordered by
 * design). That is exactly the distinction the digest needs to be stable under
 * irrelevant reordering and sensitive to real change.
 */
export function buildProviderInventory(input: ProviderInventoryInput): ProviderInventory {
  const providers: ProviderIdentity[] = [...input.providers]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((facts) => ({
      id: facts.id,
      kind: facts.kind,
      baseUrl: redactUrlUserinfo(facts.baseUrl),
      readiness: readinessOf(facts),
      credentialRequired: facts.credentialRequired,
      credentialPresent: facts.credentialPresent,
      ...(facts.credentialSource !== undefined ? { credentialSource: facts.credentialSource } : {}),
      ...(facts.configurationSource !== undefined ? { configurationSource: facts.configurationSource } : {}),
    }));

  const byId = new Map(providers.map((p) => [p.id, p]));

  const models: AvailableModel[] = [...input.models]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((model) => {
      const routes: ModelRoute[] = model.routes.map((route) => {
        const provider = byId.get(route.providerId);
        return {
          providerId: route.providerId,
          providerModelId: route.providerModelId,
          providerRegistered: provider !== undefined,
          providerReadiness: provider?.readiness ?? "unknown",
        };
      });
      return {
        id: model.id,
        ...(model.role !== undefined ? { role: model.role } : {}),
        ...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {}),
        routes,
        routable: routes.some((r) => r.providerRegistered),
        invocable: routes.some((r) => r.providerRegistered && isUsableReadiness(r.providerReadiness)),
      };
    });

  // The digest covers the CAPABILITY surface only. Filesystem paths (credentialSource,
  // configurationSource) are excluded on purpose: moving a state root does not change
  // what this machine can invoke, and a digest that moved with it would be noise.
  const digest = contentDigest("inventory", {
    providers: providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      baseUrl: p.baseUrl,
      readiness: p.readiness,
      credentialRequired: p.credentialRequired,
      credentialPresent: p.credentialPresent,
    })),
    models: models.map((m) => ({
      id: m.id,
      role: m.role,
      // Capability facts ARE part of what this machine can do, so a changed window or a
      // newly declared tool capability moves the digest.
      capabilities: m.capabilities,
      routes: m.routes.map((r) => ({ providerId: r.providerId, providerModelId: r.providerModelId })),
    })),
  });

  return {
    digest,
    providers,
    models,
    providersConfigured: providers.filter((p) => isUsableReadiness(p.readiness)).length,
    modelsInvocable: models.filter((m) => m.invocable).length,
  };
}

// ---------------------------------------------------------------------------
// Policy construction
// ---------------------------------------------------------------------------

function configFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "preflight",
    code,
    message,
    stage: "preflight",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

/** Normalize a resolved profile: role preferences sorted, parameters redacted, digested. */
function normalizeProfile(input: ResolvedProfileInput): { profile: ActiveModelProfile } | { failure: RunFailure } {
  const preferences: ProfileRolePreference[] = [];
  for (const role of Object.keys(input.roles).sort()) {
    if (!isV2ModelRole(role)) {
      return {
        failure: configFailure(
          V2_CONFIG_FAILURE_CODES.profileUnknownRole,
          `profile "${input.name}" assigns an unknown role "${role}" (known roles: ${V2_MODEL_ROLES.join(", ")})`,
          { profile: input.name, role },
        ),
      };
    }
    const assignment = input.roles[role]!;
    preferences.push({
      role,
      providerId: assignment.provider,
      modelId: assignment.model,
      required: V2_REQUIRED_ROLES.includes(role),
    });
  }

  const parameters = redactParameters(input.parameters ?? {});
  const digest = contentDigest("profile", {
    name: input.name,
    inheritanceChain: input.inheritanceChain,
    roles: preferences.map((p) => ({ role: p.role, providerId: p.providerId, modelId: p.modelId })),
    routing: input.routing ?? {},
    parameters,
    maxRunCostUsd: input.maxRunCostUsd,
  });

  return {
    profile: {
      name: input.name,
      digest,
      ...(input.description !== undefined ? { description: input.description } : {}),
      inheritanceChain: input.inheritanceChain,
      rolePreferences: preferences,
      parameters,
      source: input.source,
    },
  };
}

/** Validate a profile's preferences against what the machine can actually route. */
function validateAgainstInventory(profile: ActiveModelProfile, inventory: ProviderInventory): RunFailure | undefined {
  for (const required of V2_REQUIRED_ROLES) {
    if (!profile.rolePreferences.some((p) => p.role === required)) {
      return configFailure(
        V2_CONFIG_FAILURE_CODES.profileMissingRequiredRole,
        `profile "${profile.name}" does not define the required role "${required}"`,
        { profile: profile.name, role: required },
      );
    }
  }
  const models = new Map(inventory.models.map((m) => [m.id, m]));
  const providers = new Set(inventory.providers.map((p) => p.id));
  for (const preference of profile.rolePreferences) {
    if (!models.has(preference.modelId)) {
      return configFailure(
        V2_CONFIG_FAILURE_CODES.profileModelNotInInventory,
        `profile "${profile.name}" role "${preference.role}" names model "${preference.modelId}", which this machine has no route for`,
        { profile: profile.name, role: preference.role, model: preference.modelId },
      );
    }
    if (!providers.has(preference.providerId)) {
      return configFailure(
        V2_CONFIG_FAILURE_CODES.profileProviderNotRegistered,
        `profile "${profile.name}" role "${preference.role}" names provider "${preference.providerId}", which is not registered`,
        { profile: profile.name, role: preference.role, provider: preference.providerId },
      );
    }
  }
  return undefined;
}

/**
 * Availability facts for one (model, provider) pair.
 *
 * NOTE WHAT THIS DELIBERATELY DOES NOT DO: when no provider is named, it does not walk
 * the fallback chain looking for a winner. Choosing among routes is the RESOLVER's job
 * and its alone (`src/v2/core/resolver.ts`); pre-empting it here — even just to label a
 * readiness — would be a second, quieter route-selection path. Availability for an
 * unconstrained preference is therefore a property of the MODEL, and `providerReadiness`
 * is simply absent, because no provider has been chosen yet.
 */
function availability(
  inventory: ProviderInventory,
  modelId: string,
  providerId: string | undefined,
): {
  modelInInventory: boolean;
  providerRegistered: boolean;
  providerReadiness?: ProviderReadiness;
  satisfiable: boolean;
} {
  const model = inventory.models.find((m) => m.id === modelId);
  if (model === undefined) {
    return { modelInInventory: false, providerRegistered: false, providerReadiness: "unknown", satisfiable: false };
  }
  if (providerId === undefined) {
    return { modelInInventory: true, providerRegistered: model.routable, satisfiable: model.invocable };
  }
  const route = model.routes.find((r) => r.providerId === providerId);
  const provider = inventory.providers.find((p) => p.id === providerId);
  const readiness = route?.providerReadiness ?? provider?.readiness ?? "unknown";
  return {
    modelInInventory: true,
    providerRegistered: provider !== undefined,
    providerReadiness: readiness,
    satisfiable: provider !== undefined && route !== undefined && isUsableReadiness(readiness),
  };
}

/**
 * BUILD THE ONE POLICY.
 *
 * Precedence, highest first:
 *   1. run override      `--profile <name>` on this run
 *   2. active profile    the operator's standing selection
 *   3. operator config   an explicitly set IKBI_MODEL_* tier
 *   4. builtin default   the shipped default for that tier
 *
 * A higher layer that names a role WINS it outright; lower layers fill only the roles
 * nobody above claimed. Every resolved preference records which layer it came from,
 * so precedence is auditable rather than implied.
 */
export function buildRuntimeModelPolicy(inputs: ConfigurationInputs): PolicyResult {
  const inventory = buildProviderInventory(inputs.inventory);

  // An explicitly selected profile that cannot be resolved FAILS. It is never quietly
  // swapped for a different strategy — that would make the operator's choice a lie.
  if (inputs.activeProfile.kind === "unresolvable") {
    const { name, code, detail, source } = inputs.activeProfile;
    return {
      ok: false,
      failure: configFailure(
        V2_CONFIG_FAILURE_CODES.profileUnresolvable,
        `the selected profile "${name}" could not be resolved (${code}): ${detail}`,
        { profile: name, reason: code, source },
      ),
    };
  }

  let profile: ActiveModelProfile | undefined;
  if (inputs.activeProfile.kind === "resolved") {
    const normalized = normalizeProfile(inputs.activeProfile.profile);
    if ("failure" in normalized) return { ok: false, failure: normalized.failure };
    const invalid = validateAgainstInventory(normalized.profile, inventory);
    if (invalid !== undefined) return { ok: false, failure: invalid };
    profile = normalized.profile;
  }

  const profileLayer: RolePreferenceSource | undefined =
    profile === undefined ? undefined : profile.source === "run_override" ? "run_override" : "active_profile";

  const claimed = new Map<V2ModelRole, ResolvedRolePreference>();

  if (profile !== undefined && profileLayer !== undefined) {
    for (const preference of profile.rolePreferences) {
      const avail = availability(inventory, preference.modelId, preference.providerId);
      claimed.set(preference.role, {
        role: preference.role,
        modelId: preference.modelId,
        providerId: preference.providerId,
        source: profileLayer,
        required: preference.required,
        ...avail,
      });
    }
  }

  for (const fallback of inputs.operatorDefaults.models) {
    for (const role of OPERATOR_TIER_ROLES[fallback.tier]) {
      if (claimed.has(role)) continue; // a higher layer already owns this role
      const avail = availability(inventory, fallback.modelId, undefined);
      claimed.set(role, {
        role,
        modelId: fallback.modelId,
        source: fallback.explicit ? "operator_env" : "builtin_default",
        required: V2_REQUIRED_ROLES.includes(role),
        ...avail,
      });
    }
  }

  const rolePreferences = [...claimed.values()].sort((a, b) => a.role.localeCompare(b.role));
  const routing = inputs.activeProfile.kind === "resolved" ? inputs.activeProfile.profile.routing : undefined;
  const maxRunCostUsd = inputs.activeProfile.kind === "resolved" ? inputs.activeProfile.profile.maxRunCostUsd : undefined;
  const constraints: PolicyConstraints = {
    ...(maxRunCostUsd !== undefined ? { maxRunCostUsd } : {}),
    ...(routing?.cheapTier !== undefined ? { cheapTier: routing.cheapTier } : {}),
    ...(routing?.fallbackProfile !== undefined ? { fallbackProfile: routing.fallbackProfile } : {}),
  };

  const unsatisfiableRequiredRoles = rolePreferences
    .filter((p) => p.required && !p.satisfiable)
    .map((p) => p.role);

  const policyId = contentDigest("policy", {
    inventory: inventory.digest,
    profile: profile?.digest ?? null,
    profileSource: profileLayer ?? "none",
    rolePreferences: rolePreferences.map((p) => ({
      role: p.role,
      modelId: p.modelId,
      providerId: p.providerId,
      source: p.source,
    })),
    constraints,
  });

  return {
    ok: true,
    policy: deepFreeze({
      policyId,
      ...(profile !== undefined ? { profile } : {}),
      profileSource: profileLayer ?? "none",
      inventory,
      rolePreferences,
      constraints,
      unsatisfiableRequiredRoles,
    }),
  };
}

/**
 * Freeze a policy through and through. The types already say `readonly`, but a policy
 * outlives the function that built it and is handed to code written later; making the
 * immutability real means a future slice cannot "just tweak one field" without that
 * being an obvious, throwing mistake.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}
