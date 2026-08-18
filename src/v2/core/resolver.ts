/**
 * ikbi v2 — THE SINGLE MODEL RESOLUTION AUTHORITY.
 *
 * Exactly one function in v2 answers "which model/provider route is authorized to be
 * invoked for this role?" — `resolveModelRoute`. Everything it needs arrives as
 * arguments: the immutable `RuntimeModelPolicy` from the configuration boundary, and a
 * request naming a role. It reads no environment variable, no config singleton, no
 * profile file, no roster; it holds no state and performs no I/O.
 *
 * WHAT IT PRODUCES: an authorization, not an invocation. A `ModelResolutionDecision`
 * says "this exact route was authorized, for this reason, under this policy". The
 * invocation layer that arrives in a later slice does not get to select anything — it
 * is handed a route and a reason it can quote.
 *
 * THE FOUR RULES THAT MAKE IT AN AUTHORITY RATHER THAN A HELPER:
 *
 *   1. READINESS IS A GATE, NOT A HINT. Only `configured` and `keyless` routes may be
 *      selected. `unknown` is never treated as optimistic — a provider that cannot
 *      describe itself is not authorized, and this slice will not make a network call
 *      to improve that answer.
 *   2. AN EXPLICIT PROVIDER IS A CONSTRAINT. When a preference names provider P and
 *      model M, the resolver returns P/M or it FAILS. It never quietly serves M through
 *      some other provider — operator-selected provider identity is authoritative.
 *   3. NO SILENT SUBSTITUTION. If the winning preference's model cannot be selected,
 *      the resolution fails. A lower-precedence layer does not get to step in; the
 *      precedence question was already settled when the policy was built.
 *   4. NO INVENTED CAPABILITY. A requirement is evaluated only against capability facts
 *      the inventory could state truthfully (roster-declared or classified). An
 *      unclassified model carries no facts, so a requirement against it fails rather
 *      than being waved through on a conservative default.
 *
 * DELIBERATELY NOT HERE (parked, and each must one day become a STRATEGY INSIDE this
 * resolver rather than a competing path): tier presets, expert rental / MoE, Luak
 * rankings, complexity routing, fallback-profile activation, recovery escalation.
 */

import {
  contentDigest,
  type V2DecisionDigest,
  type V2PolicyDigest,
  type V2RunId,
} from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import {
  isV2ModelRole,
  type ModelCapabilityFacts,
  type ProviderReadiness,
  type RolePreferenceSource,
  type RuntimeModelPolicy,
  type V2ModelRole,
  isUsableReadiness,
} from "./config.js";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Capability requirements a caller may state.
 *
 * Deliberately tiny. Every key here can be answered LOCALLY and TRUTHFULLY from
 * capability facts the inventory actually has; a requirement that would need a network
 * probe, a benchmark, or a guess has no key and cannot be expressed.
 */
export interface ModelRequirements {
  /** The role's work needs native tool/function calling. */
  readonly requiresTools?: boolean;
  /** The role's work needs extended thinking. */
  readonly requiresThinking?: boolean;
  /** The role's work needs at least this many context tokens. */
  readonly minContextWindow?: number;
}

/** The requirement keys this slice can evaluate. Anything else is refused, not ignored. */
export const SUPPORTED_REQUIREMENT_KEYS: readonly string[] = ["requiresTools", "requiresThinking", "minContextWindow"];

/**
 * One resolution request. Immutable, and it names the policy it expects — so a decision
 * can never be produced against a policy other than the one the run recorded.
 */
export interface ModelResolutionRequest {
  readonly runId: V2RunId;
  readonly policyId: V2PolicyDigest;
  readonly role: V2ModelRole;
  readonly requirements?: ModelRequirements;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Why this route won. Closed set — no free-text rationale. */
export type ResolutionBasis =
  /** The preference named a provider, and that exact route was authorized. */
  | "explicit_provider_constraint"
  /** The preference named only a model; the first selectable route in the declared chain won. */
  | "first_selectable_route";

/** Whether the preference pinned a provider. */
export type ProviderConstraint = "explicit" | "unconstrained";

/** The requirements that were actually evaluated, echoed so a decision explains itself. */
export interface EvaluatedRequirements {
  readonly requiresTools: boolean;
  readonly requiresThinking: boolean;
  readonly minContextWindow: number;
}

/**
 * THE authorization. Everything the future invocation layer needs, so that it selects
 * nothing: which logical model, which provider, which provider-side model id, where the
 * endpoint is, and the static capability facts that shape the request.
 *
 * Contains no credential, no mutable provider object, and no cost accounting.
 */
export interface ModelResolutionDecision {
  readonly decisionId: V2DecisionDigest;
  readonly runId: V2RunId;
  readonly policyId: V2PolicyDigest;
  readonly role: V2ModelRole;
  /** The LOGICAL roster model id the operator's preference named. */
  readonly modelId: string;
  readonly providerId: string;
  /** The id to send on the wire — may differ from the logical id. */
  readonly providerModelId: string;
  /** Position of the winning route in the model's declared fallback chain (0-based). */
  readonly routeOrdinal: number;
  readonly routeCount: number;
  readonly preferenceSource: RolePreferenceSource;
  readonly providerConstraint: ProviderConstraint;
  /** Always `configured` or `keyless` — the gate guarantees it. */
  readonly providerReadiness: ProviderReadiness;
  readonly providerKind: string;
  /** Endpoint for the authorized route. Userinfo already stripped upstream. */
  readonly baseUrl: string;
  readonly basis: ResolutionBasis;
  readonly requirements: EvaluatedRequirements;
  /** Static facts for the invocation layer. Absent when the model is unclassified. */
  readonly capabilities?: ModelCapabilityFacts;
}

/** A resolution either authorizes exactly one route or fails with a structured reason. */
export type ModelResolutionResult =
  | { readonly ok: true; readonly decision: ModelResolutionDecision }
  | { readonly ok: false; readonly failure: RunFailure };

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Every way resolution can refuse. Closed set; each names one specific impossibility. */
export const V2_RESOLUTION_FAILURE_CODES = {
  roleUnknown: "resolution.role_unknown",
  roleNotConfigured: "resolution.role_not_configured",
  modelNotInInventory: "resolution.model_not_in_inventory",
  providerNotRegistered: "resolution.provider_not_registered",
  providerNotSelectable: "resolution.provider_not_selectable",
  noSelectableRoute: "resolution.no_selectable_route",
  capabilityUnsatisfied: "resolution.capability_unsatisfied",
  policyIdentityMismatch: "resolution.policy_identity_mismatch",
  unsupportedRequirement: "resolution.unsupported_requirement",
  internal: "resolution.internal_error",
} as const;

function resolutionFailure(
  code: string,
  message: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): RunFailure {
  return runFailure({
    category: "resolution",
    code,
    message,
    stage: "model_resolution",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/** Normalize the optional requirements into the form the decision records. */
function evaluatedRequirements(requirements: ModelRequirements | undefined): EvaluatedRequirements {
  return {
    requiresTools: requirements?.requiresTools ?? false,
    requiresThinking: requirements?.requiresThinking ?? false,
    minContextWindow: requirements?.minContextWindow ?? 0,
  };
}

/** Is any requirement actually being asked for? Determines whether facts are needed at all. */
function requiresAnything(evaluated: EvaluatedRequirements): boolean {
  return evaluated.requiresTools || evaluated.requiresThinking || evaluated.minContextWindow > 0;
}

/**
 * THE canonical resolution. Pure: same policy + same request ⇒ same decision, in this
 * process or any other.
 */
export function resolveModelRoute(policy: RuntimeModelPolicy, request: ModelResolutionRequest): ModelResolutionResult {
  // 0. The request must be about THIS policy. A decision carrying one policy id while
  //    having been computed from another would be the exact ambiguity this slice ends.
  if (request.policyId !== policy.policyId) {
    return {
      ok: false,
      failure: resolutionFailure(
        V2_RESOLUTION_FAILURE_CODES.policyIdentityMismatch,
        "the resolution request names a different runtime policy than the one supplied",
        { requested: request.policyId, supplied: policy.policyId },
      ),
    };
  }

  if (!isV2ModelRole(request.role)) {
    return {
      ok: false,
      failure: resolutionFailure(V2_RESOLUTION_FAILURE_CODES.roleUnknown, `"${String(request.role)}" is not a known model role`, {
        role: String(request.role),
      }),
    };
  }

  // Unknown requirement keys are REFUSED. A request arriving as JSON from a later
  // surface must not have an unrecognized constraint silently dropped.
  for (const key of Object.keys(request.requirements ?? {})) {
    if (!SUPPORTED_REQUIREMENT_KEYS.includes(key)) {
      return {
        ok: false,
        failure: resolutionFailure(
          V2_RESOLUTION_FAILURE_CODES.unsupportedRequirement,
          `requirement "${key}" cannot be evaluated locally (supported: ${SUPPORTED_REQUIREMENT_KEYS.join(", ")})`,
          { requirement: key },
        ),
      };
    }
  }

  // 1. THE PREFERENCE. Precedence was settled when the policy was built; the resolver
  //    reads the winner and never reconsiders a lower layer.
  const preference = policy.rolePreferences.find((p) => p.role === request.role);
  if (preference === undefined) {
    return {
      ok: false,
      failure: resolutionFailure(
        V2_RESOLUTION_FAILURE_CODES.roleNotConfigured,
        `no configuration layer expressed a model preference for role "${request.role}"`,
        { role: request.role },
      ),
    };
  }

  // 2. THE MODEL must exist in the inventory. A preference cannot invent a route.
  const model = policy.inventory.models.find((m) => m.id === preference.modelId);
  if (model === undefined) {
    return {
      ok: false,
      failure: resolutionFailure(
        V2_RESOLUTION_FAILURE_CODES.modelNotInInventory,
        `role "${request.role}" prefers model "${preference.modelId}", which this machine has no route for`,
        { role: request.role, model: preference.modelId, source: preference.source },
      ),
    };
  }

  // 3. CAPABILITY is a property of the MODEL, so it is settled before any route is
  //    considered — no route can rescue a model that cannot do the work.
  const requirements = evaluatedRequirements(request.requirements);
  if (requiresAnything(requirements)) {
    const unmet = unmetRequirements(model.capabilities, requirements);
    if (unmet !== undefined) {
      return {
        ok: false,
        failure: resolutionFailure(
          V2_RESOLUTION_FAILURE_CODES.capabilityUnsatisfied,
          `model "${model.id}" cannot satisfy the requirements for role "${request.role}": ${unmet}`,
          { role: request.role, model: model.id, reason: unmet },
        ),
      };
    }
  }

  // 4. THE ROUTE.
  const routes = model.routes;
  if (preference.providerId !== undefined) {
    // EXPLICIT CONSTRAINT — resolve exactly this provider or fail. Never substitute.
    const providerId = preference.providerId;
    const ordinal = routes.findIndex((r) => r.providerId === providerId);
    const route = ordinal >= 0 ? routes[ordinal] : undefined;
    if (route === undefined) {
      const registered = policy.inventory.providers.some((p) => p.id === providerId);
      return {
        ok: false,
        failure: registered
          ? resolutionFailure(
              V2_RESOLUTION_FAILURE_CODES.noSelectableRoute,
              `provider "${providerId}" is registered but serves no route for model "${model.id}"`,
              { role: request.role, model: model.id, provider: providerId },
            )
          : resolutionFailure(
              V2_RESOLUTION_FAILURE_CODES.providerNotRegistered,
              `role "${request.role}" names provider "${providerId}", which is not registered on this machine`,
              { role: request.role, provider: providerId },
            ),
      };
    }
    if (!route.providerRegistered) {
      return {
        ok: false,
        failure: resolutionFailure(
          V2_RESOLUTION_FAILURE_CODES.providerNotRegistered,
          `role "${request.role}" names provider "${providerId}", which is not registered on this machine`,
          { role: request.role, provider: providerId },
        ),
      };
    }
    if (!isUsableReadiness(route.providerReadiness)) {
      // Note the deliberate silence about alternatives: naming one here would invite
      // exactly the substitution this rule forbids.
      return {
        ok: false,
        failure: resolutionFailure(
          V2_RESOLUTION_FAILURE_CODES.providerNotSelectable,
          `provider "${providerId}" is ${route.providerReadiness} — role "${request.role}" pins it explicitly, so no other provider may serve model "${model.id}"`,
          { role: request.role, model: model.id, provider: providerId, readiness: route.providerReadiness },
        ),
      };
    }
    return authorize(policy, request, preference.source, model.id, ordinal, "explicit", "explicit_provider_constraint", requirements, {
      providerId: route.providerId,
      providerModelId: route.providerModelId,
      readiness: route.providerReadiness,
      routeCount: routes.length,
      capabilities: model.capabilities,
    });
  }

  // UNCONSTRAINED — the roster's declared chain IS the ordering. First selectable wins;
  // the ordinal is recorded so the choice is explainable rather than merely asserted.
  const ordinal = routes.findIndex((r) => r.providerRegistered && isUsableReadiness(r.providerReadiness));
  const route = ordinal >= 0 ? routes[ordinal] : undefined;
  if (route === undefined) {
    return {
      ok: false,
      failure: resolutionFailure(
        V2_RESOLUTION_FAILURE_CODES.noSelectableRoute,
        `model "${model.id}" has no selectable route for role "${request.role}" — ${describeRoutes(model.routes)}`,
        { role: request.role, model: model.id, routes: routes.length },
      ),
    };
  }
  return authorize(policy, request, preference.source, model.id, ordinal, "unconstrained", "first_selectable_route", requirements, {
    providerId: route.providerId,
    providerModelId: route.providerModelId,
    readiness: route.providerReadiness,
    routeCount: routes.length,
    capabilities: model.capabilities,
  });
}

/** Human-readable account of why nothing was selectable. Never names a substitute. */
function describeRoutes(routes: readonly { providerId: string; providerRegistered: boolean; providerReadiness: ProviderReadiness }[]): string {
  if (routes.length === 0) return "it declares no routes";
  return routes
    .map((r) => `${r.providerId}=${r.providerRegistered ? r.providerReadiness : "not_registered"}`)
    .join(", ");
}

/** Check requirements against facts. Returns the first unmet reason, or undefined. */
function unmetRequirements(capabilities: ModelCapabilityFacts | undefined, requirements: EvaluatedRequirements): string | undefined {
  if (capabilities === undefined) {
    // The model is unclassified and the roster declares nothing. v2 will NOT answer a
    // capability question from a conservative fallback and call it truth.
    return "no capability facts are known for this model (unclassified, and the roster declares none)";
  }
  if (requirements.requiresTools && !capabilities.supportsTools) return "native tool calling is required but not supported";
  if (requirements.requiresThinking && capabilities.supportsThinking !== true) return "extended thinking is required but not supported";
  if (requirements.minContextWindow > capabilities.contextWindow) {
    return `a ${requirements.minContextWindow}-token context is required but the window is ${capabilities.contextWindow}`;
  }
  return undefined;
}

/** Assemble and content-address the authorization. */
function authorize(
  policy: RuntimeModelPolicy,
  request: ModelResolutionRequest,
  preferenceSource: RolePreferenceSource,
  modelId: string,
  routeOrdinal: number,
  providerConstraint: ProviderConstraint,
  basis: ResolutionBasis,
  requirements: EvaluatedRequirements,
  route: {
    providerId: string;
    providerModelId: string;
    readiness: ProviderReadiness;
    routeCount: number;
    capabilities: ModelCapabilityFacts | undefined;
  },
): ModelResolutionResult {
  const provider = policy.inventory.providers.find((p) => p.id === route.providerId);
  if (provider === undefined) {
    // Unreachable given the checks above; treated as an engine defect, not a user error.
    return {
      ok: false,
      failure: resolutionFailure(
        V2_RESOLUTION_FAILURE_CODES.internal,
        `route selection produced provider "${route.providerId}", which is absent from the inventory it came from`,
        { provider: route.providerId },
      ),
    };
  }

  // THE DIGEST covers SEMANTIC SELECTION only: which policy, which role, which route,
  // under which preference layer and constraints. Route ORDINAL and provider READINESS
  // are excluded on purpose — they are consequences of the inventory, which is already
  // bound in via `policyId`, so including them would only add noise. No credential-
  // derived value participates.
  const decisionId = contentDigest("decision", {
    policyId: policy.policyId,
    role: request.role,
    modelId,
    providerId: route.providerId,
    providerModelId: route.providerModelId,
    preferenceSource,
    providerConstraint,
    requirements,
  });

  return {
    ok: true,
    decision: Object.freeze({
      decisionId,
      runId: request.runId,
      policyId: policy.policyId,
      role: request.role,
      modelId,
      providerId: route.providerId,
      providerModelId: route.providerModelId,
      routeOrdinal,
      routeCount: route.routeCount,
      preferenceSource,
      providerConstraint,
      providerReadiness: route.readiness,
      providerKind: provider.kind,
      baseUrl: provider.baseUrl,
      basis,
      requirements: Object.freeze(requirements),
      ...(route.capabilities !== undefined ? { capabilities: route.capabilities } : {}),
    }),
  };
}
