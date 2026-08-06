/**
 * Local-only provider/model readiness resolution.
 *
 * This module deliberately consumes the already-resolved config and provider
 * registry. It does not load a second configuration format, invoke a model, or
 * perform network I/O. A provider's optional `preflightInfo()` is metadata only;
 * `ready()` is the existing local credential/keyless check.
 */

import type { IkbiConfig, ProviderConfig } from "../config.js";
import type { ModelProvider } from "./contract.js";
import type { ModelSpec } from "./registry.js";

export const PROVIDER_PREFLIGHT_CODES = Object.freeze([
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_NOT_IN_ROSTER",
  "MODEL_NOT_CONFIGURED",
  "MODEL_NOT_IN_ROSTER",
  "PROVIDER_CREDENTIAL_MISSING",
  "PROVIDER_CONFIGURATION_INVALID",
  "PROVIDER_ROLE_UNRESOLVED",
  "PROVIDER_PREFLIGHT_INTERNAL_ERROR",
] as const);

export type ProviderPreflightIssueCode = (typeof PROVIDER_PREFLIGHT_CODES)[number];

export interface ProviderPreflightRoleAssignment {
  readonly role: string;
  readonly required: boolean;
  readonly model?: string;
  /** Safe source label for the role assignment, never a value. */
  readonly configurationSource?: string;
}

export interface ProviderPreflightRegistry {
  readonly getModel: (id: string) => ModelSpec | undefined;
  readonly getProvider: (id: string) => ModelProvider | undefined;
}

export interface ProviderPreflightIssue {
  readonly code: ProviderPreflightIssueCode;
  readonly role: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly message: string;
  readonly retryable: boolean;
  readonly blocksBuild: boolean;
  readonly recovery: string;
  readonly configurationSource: string | null;
}

export interface ProviderPreflightRole {
  readonly role: string;
  readonly required: boolean;
  readonly model: string | null;
  readonly provider: string | null;
  readonly providerInRoster: boolean;
  readonly modelInRoster: boolean;
  readonly credentialRequired: boolean;
  readonly credentialPresent: boolean;
  readonly credentialSource: string | null;
  readonly endpointConfigurationValid: boolean;
  readonly ready: boolean;
  readonly configurationSource: string | null;
  readonly issues: readonly ProviderPreflightIssue[];
}

export interface ProviderPreflightSource {
  readonly key: string;
  readonly source: string;
}

export interface ProviderPreflightReport {
  readonly command: "doctor.checkProviders";
  readonly status: "ready" | "blocked" | "error";
  readonly localOnly: true;
  readonly remoteReachability: "not_checked";
  readonly resolvedConfiguration: {
    readonly sources: readonly ProviderPreflightSource[];
    readonly providerRosterSource: string | null;
  };
  readonly roles: readonly ProviderPreflightRole[];
  readonly issues: readonly ProviderPreflightIssue[];
  readonly recovery: readonly string[];
  readonly wouldStartPaidInvocation: false;
}

export interface ProviderPreflightInputs {
  readonly config: IkbiConfig;
  readonly registry: ProviderPreflightRegistry;
  readonly roles: readonly ProviderPreflightRoleAssignment[];
  readonly env?: NodeJS.ProcessEnv;
  readonly dotenvProvenance?: ReadonlyMap<string, string>;
}

type BuiltinProviderConfigKey =
  | "mimo"
  | "openrouter"
  | "deepseek"
  | "minimax"
  | "openai"
  | "anthropic"
  | "ollama"
  | "google"
  | "groq"
  | "mistral"
  | "together";

interface BuiltinProviderDescriptor {
  readonly configKey: BuiltinProviderConfigKey;
  readonly baseUrlEnv: string;
  readonly credentialEnv?: string;
  readonly kind: "openai-compatible" | "anthropic";
}

const BUILTIN_PROVIDERS: Readonly<Record<string, BuiltinProviderDescriptor>> = Object.freeze({
  mimo: { configKey: "mimo", baseUrlEnv: "IKBI_MIMO_BASE_URL", credentialEnv: "IKBI_MIMO_API_KEY", kind: "openai-compatible" },
  openrouter: { configKey: "openrouter", baseUrlEnv: "IKBI_OPENROUTER_BASE_URL", credentialEnv: "IKBI_OPENROUTER_API_KEY", kind: "openai-compatible" },
  deepseek: { configKey: "deepseek", baseUrlEnv: "IKBI_DEEPSEEK_BASE_URL", credentialEnv: "IKBI_DEEPSEEK_API_KEY", kind: "openai-compatible" },
  minimax: { configKey: "minimax", baseUrlEnv: "IKBI_MINIMAX_BASE_URL", credentialEnv: "IKBI_MINIMAX_API_KEY", kind: "openai-compatible" },
  openai: { configKey: "openai", baseUrlEnv: "IKBI_OPENAI_BASE_URL", credentialEnv: "IKBI_OPENAI_API_KEY", kind: "openai-compatible" },
  anthropic: { configKey: "anthropic", baseUrlEnv: "IKBI_ANTHROPIC_BASE_URL", credentialEnv: "IKBI_ANTHROPIC_API_KEY", kind: "anthropic" },
  ollama: { configKey: "ollama", baseUrlEnv: "IKBI_OLLAMA_BASE_URL", kind: "openai-compatible" },
  google: { configKey: "google", baseUrlEnv: "IKBI_GOOGLE_BASE_URL", credentialEnv: "IKBI_GOOGLE_API_KEY", kind: "openai-compatible" },
  groq: { configKey: "groq", baseUrlEnv: "IKBI_GROQ_BASE_URL", credentialEnv: "IKBI_GROQ_API_KEY", kind: "openai-compatible" },
  mistral: { configKey: "mistral", baseUrlEnv: "IKBI_MISTRAL_BASE_URL", credentialEnv: "IKBI_MISTRAL_API_KEY", kind: "openai-compatible" },
  together: { configKey: "together", baseUrlEnv: "IKBI_TOGETHER_BASE_URL", credentialEnv: "IKBI_TOGETHER_API_KEY", kind: "openai-compatible" },
});

interface ProviderInfo {
  readonly kind: string;
  readonly baseUrl: string;
  readonly credentialRequired: boolean;
  readonly credentialPresent: boolean;
  readonly credentialSource?: string;
  readonly credentialEnv?: string;
  readonly configurationSource?: string;
}

interface RouteState {
  readonly providerId: string;
  readonly provider: ModelProvider | undefined;
  readonly info: ProviderInfo | undefined;
  readonly endpointValid: boolean;
  readonly credentialReady: boolean;
  readonly ready: boolean;
}

function sourceFor(key: string, env: NodeJS.ProcessEnv, provenance: ReadonlyMap<string, string>): string {
  const file = provenance.get(key);
  if (file !== undefined) return `.env (${file})`;
  return env[key]?.trim() ? "environment" : "built-in default";
}

function validEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0 && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function builtinInfo(
  providerId: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  provenance: ReadonlyMap<string, string>,
): ProviderInfo | undefined {
  const descriptor = BUILTIN_PROVIDERS[providerId];
  if (descriptor === undefined) return undefined;
  const endpoint = config[descriptor.configKey];
  const credentialRequired = descriptor.credentialEnv !== undefined;
  const credentialPresent = !credentialRequired || endpoint.apiKey !== undefined;
  return {
    kind: descriptor.kind,
    baseUrl: endpoint.baseUrl,
    credentialRequired,
    credentialPresent,
    ...(credentialPresent
      ? { credentialSource: credentialRequired ? sourceFor(descriptor.credentialEnv!, env, provenance) : "keyless" }
      : { credentialSource: sourceFor(descriptor.credentialEnv!, env, provenance) }),
    ...(descriptor.credentialEnv !== undefined ? { credentialEnv: descriptor.credentialEnv } : {}),
    configurationSource: sourceFor(descriptor.baseUrlEnv, env, provenance),
  };
}

function inspectProvider(
  providerId: string,
  provider: ModelProvider | undefined,
  inputs: ProviderPreflightInputs,
  provenance: ReadonlyMap<string, string>,
): ProviderInfo | undefined {
  if (provider === undefined) return undefined;
  const declared = provider.preflightInfo?.();
  const builtin = builtinInfo(providerId, inputs.config.provider, inputs.env ?? process.env, provenance);
  if (declared === undefined) return builtin;
  return {
    ...declared,
    ...(declared.credentialSource === undefined && builtin?.credentialEnv !== undefined ? { credentialEnv: builtin.credentialEnv } : {}),
    ...(declared.credentialSource === undefined && builtin?.credentialSource !== undefined
      ? { credentialSource: builtin.credentialSource }
      : {}),
    ...(declared.configurationSource === undefined && builtin?.configurationSource !== undefined
      ? { configurationSource: builtin.configurationSource }
      : {}),
  };
}

function credentialRecovery(state: RouteState, rosterFile: string): string {
  const envKey = state.info?.credentialEnv;
  if (envKey !== undefined) return `Set ${envKey} in the shell, ~/.ikbi/env, or the install-root .env; rerun ikbi doctor --check-providers.`;
  if (state.info?.credentialSource?.toLowerCase().includes("roster")) {
    return `Add the provider credential to the provider entry in ${state.info.configurationSource ?? rosterFile}, or mark the provider explicitly keyless; rerun ikbi doctor --check-providers.`;
  }
  return `Configure a credential for provider "${state.providerId}" through its production configuration, then rerun ikbi doctor --check-providers.`;
}

function issue(
  assignment: ProviderPreflightRoleAssignment,
  code: ProviderPreflightIssueCode,
  message: string,
  recovery: string,
  provider: string | null,
  model: string | null,
  blocksBuild: boolean = assignment.required,
): ProviderPreflightIssue {
  return {
    code,
    role: assignment.role,
    provider,
    model,
    message,
    retryable: false,
    blocksBuild,
    recovery,
    configurationSource: assignment.configurationSource ?? null,
  };
}

function roleResult(
  assignment: ProviderPreflightRoleAssignment,
  registry: ProviderPreflightRegistry,
  inputs: ProviderPreflightInputs,
  provenance: ReadonlyMap<string, string>,
): ProviderPreflightRole {
  const model = assignment.model?.trim() || undefined;
  const modelValue = model ?? null;
  const base = {
    role: assignment.role,
    required: assignment.required,
    model: modelValue,
    provider: null as string | null,
    providerInRoster: false,
    modelInRoster: false,
    credentialRequired: false,
    credentialPresent: false,
    credentialSource: null as string | null,
    endpointConfigurationValid: false,
    ready: false,
    configurationSource: assignment.configurationSource ?? null,
  };

  if (model === undefined) {
    const problems = assignment.required
      ? [issue(assignment, "MODEL_NOT_CONFIGURED", `No model is assigned to the ${assignment.role} role.`, `Set the model assignment for ${assignment.role} in the documented IKBI_* configuration, then rerun ikbi doctor --check-providers.`, null, null)]
      : [];
    return { ...base, ready: problems.length === 0, issues: problems };
  }

  const spec = registry.getModel(model);
  if (spec === undefined) {
    const problems = [issue(assignment, "MODEL_NOT_IN_ROSTER", `Model "${model}" is not present in the local provider/model roster.`, `Add model "${model}" and a provider route to ${inputs.config.provider.rosterFile}, or set the ${assignment.role} model to a model already listed there.`, null, model)];
    return { ...base, issues: problems };
  }

  const routes = spec.providers;
  if (routes.length === 0) {
    const problems = [issue(assignment, "PROVIDER_NOT_CONFIGURED", `Model "${model}" has no provider route for the ${assignment.role} role.`, `Add at least one provider route for model "${model}" in ${inputs.config.provider.rosterFile}.`, null, model)];
    return { ...base, modelInRoster: true, issues: problems };
  }

  const states: RouteState[] = [];
  for (const route of routes) {
    const provider = registry.getProvider(route.provider);
    const info = inspectProvider(route.provider, provider, inputs, provenance);
    const endpointValid = info !== undefined && validEndpoint(info.baseUrl);
    const credentialReady = info === undefined || !info.credentialRequired || info.credentialPresent;
    const ready = provider !== undefined && endpointValid && credentialReady && (provider.ready?.() ?? true);
    states.push({ providerId: route.provider, provider, info, endpointValid, credentialReady, ready });
  }

  const selected = states.find((state) => state.ready) ?? states.find((state) => state.provider !== undefined) ?? states[0]!;
  const selectedInfo = selected.info;
  const problems: ProviderPreflightIssue[] = [];
  const anyReady = states.some((state) => state.ready);

  if (selected.provider === undefined) {
    for (const state of states) {
      problems.push(issue(assignment, "PROVIDER_NOT_IN_ROSTER", `Provider "${state.providerId}" required by model "${model}" is not present in the local provider roster.`, `Add provider "${state.providerId}" to ${inputs.config.provider.rosterFile}, or change the ${assignment.role} model to one with a registered provider route.`, state.providerId, model));
    }
  } else {
    for (const state of states.filter((candidate) => !candidate.ready && candidate.provider !== undefined)) {
      const provider = state.provider;
      if (provider === undefined) continue;
      if (!state.endpointValid) {
        problems.push(issue(assignment, "PROVIDER_CONFIGURATION_INVALID", `Provider "${state.providerId}" has an invalid local endpoint configuration.`, `Fix the provider base URL for "${state.providerId}" in ${state.info?.configurationSource ?? inputs.config.provider.rosterFile}; it must be an http(s) URL without embedded credentials.`, state.providerId, model, !anyReady && assignment.required));
      }
      if (state.endpointValid && !state.credentialReady) {
        problems.push(issue(assignment, "PROVIDER_CREDENTIAL_MISSING", `Provider "${state.providerId}" has no credential configured for model "${model}".`, credentialRecovery(state, inputs.config.provider.rosterFile), state.providerId, model, !anyReady && assignment.required));
      }
      if (state.endpointValid && state.credentialReady && !(provider.ready?.() ?? true)) {
        problems.push(issue(assignment, "PROVIDER_CONFIGURATION_INVALID", `Provider "${state.providerId}" reports that its local configuration is not usable.`, `Review the provider entry and credential configuration for "${state.providerId}" in ${state.info?.configurationSource ?? inputs.config.provider.rosterFile}.`, state.providerId, model, !anyReady && assignment.required));
      }
    }
  }

  const ready = states.some((state) => state.ready);
  if (!ready && problems.length === 0) {
    problems.push(issue(assignment, "PROVIDER_ROLE_UNRESOLVED", `No locally usable provider route resolves model "${model}" for the ${assignment.role} role.`, `Review the model routes and provider configuration in ${inputs.config.provider.rosterFile}, then rerun ikbi doctor --check-providers.`, selected.providerId, model));
  }

  return {
    ...base,
    provider: selected.providerId,
    providerInRoster: selected.provider !== undefined,
    modelInRoster: true,
    credentialRequired: selectedInfo?.credentialRequired ?? false,
    credentialPresent: selectedInfo?.credentialPresent ?? (selected.provider?.ready?.() ?? false),
    credentialSource: selectedInfo?.credentialSource ?? null,
    endpointConfigurationValid: selected.endpointValid,
    ready,
    issues: problems,
  };
}

function sourceEntries(
  inputs: ProviderPreflightInputs,
  provenance: ReadonlyMap<string, string>,
): ProviderPreflightSource[] {
  const env = inputs.env ?? process.env;
  const keys = new Set<string>();
  for (const key of ["IKBI_MODEL_DRIVER", "IKBI_MODEL_BUILDER", "IKBI_MODEL_CRITIC", "IKBI_COMPETITIVE_MODELS"]) keys.add(key);
  for (const assignment of inputs.roles) {
    const key = assignment.configurationSource?.match(/^[A-Z][A-Z0-9_]+/)?.[0];
    if (key !== undefined) keys.add(key);
  }
  keys.add("IKBI_PROVIDER_CONFIG");
  for (const descriptor of Object.values(BUILTIN_PROVIDERS)) {
    keys.add(descriptor.baseUrlEnv);
    if (descriptor.credentialEnv !== undefined) keys.add(descriptor.credentialEnv);
  }
  return [...keys].sort().map((key) => ({ key, source: sourceFor(key, env, provenance) }));
}

export function resolveProviderPreflight(inputs: ProviderPreflightInputs): ProviderPreflightReport {
  const provenance = inputs.dotenvProvenance ?? new Map<string, string>();
  const roles = inputs.roles.map((assignment) => roleResult(assignment, inputs.registry, inputs, provenance));
  const issues = roles.flatMap((role) => role.issues);
  const blocking = issues.some((problem) => problem.blocksBuild);
  const recovery = [...new Set(issues.map((problem) => `${problem.role}: ${problem.recovery}`))];
  return {
    command: "doctor.checkProviders",
    status: blocking ? "blocked" : "ready",
    localOnly: true,
    remoteReachability: "not_checked",
    resolvedConfiguration: {
      sources: sourceEntries(inputs, provenance),
      providerRosterSource: inputs.config.provider.rosterFile,
    },
    roles,
    issues,
    recovery,
    wouldStartPaidInvocation: false,
  };
}

export function renderProviderPreflight(report: ProviderPreflightReport): readonly string[] {
  const lines: string[] = [
    "PROVIDER PREFLIGHT (LOCAL ONLY)",
    "  remote reachability: not checked",
    "  would start paid invocation: no",
    `  provider/model roster: ${report.resolvedConfiguration.providerRosterSource ?? "(none)"}`,
    "",
    "ROLES",
  ];
  for (const role of report.roles) {
    const model = role.model ?? "(not configured)";
    const provider = role.provider ?? "(unresolved)";
    const credential = role.credentialRequired ? (role.credentialPresent ? `present (${role.credentialSource ?? "source not exposed"})` : "missing") : `not required (${role.credentialSource ?? "keyless"})`;
    lines.push(`  ${role.ready ? "✓" : role.required ? "✗" : "⚠"} ${role.role} [${role.required ? "required" : "optional"}] model=${model} provider=${provider} modelInRoster=${role.modelInRoster ? "yes" : "no"} providerInRoster=${role.providerInRoster ? "yes" : "no"} credential=${credential} endpoint=${role.endpointConfigurationValid ? "valid" : "invalid/unresolved"}`);
  }
  if (report.issues.length > 0) {
    lines.push("", "ISSUES");
    for (const problem of report.issues) {
      lines.push(`  ${problem.code} role=${problem.role}${problem.model === null ? "" : ` model=${problem.model}`}${problem.provider === null ? "" : ` provider=${problem.provider}`} — ${problem.message}`);
      lines.push(`    retryable=${problem.retryable ? "yes" : "no"} blocksBuild=${problem.blocksBuild ? "yes" : "no"}`);
      lines.push(`    recovery: ${problem.recovery}`);
    }
  }
  lines.push("", report.status === "ready" ? "provider configuration locally ready (remote reachability not checked)" : "provider configuration BLOCKED locally — no model invocation was attempted");
  return lines;
}
