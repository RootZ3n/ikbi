/**
 * ikbi capability-registry consumer — the in-repo binding to the lab's shared
 * capability registry (L6 autonomy safety layer, req #1).
 *
 * Status: DORMANT — This module is built but not yet wired into production.
 * It will be activated when ikbi needs to advertise its capabilities to agents
 * (e.g., for inter-agent delegation, tool discovery, or governed unattended
 * execution). Do not delete.
 *
 * ikbi stays STANDALONE: this module does not import a shared package. It consumes
 * the shared registry as DATA (the JSON contract at lab-capability/registry.json,
 * located via the LAB_CAPABILITY_REGISTRY env var or an explicit path) and runs the
 * same deny-by-default policy as every other repo. Trust tier is NOT a capability —
 * an ikbi worker is still denied any operation it was not explicitly granted here.
 *
 * Self-contained + additive: it pins no frozen-core contract, registers no command,
 * and is imported by nothing in the hot path. It is a library the unattended/governed
 * caller invokes before acting. DENY BY DEFAULT; fail closed on everything.
 */

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export const RISK_ORDER = ["low", "medium", "high", "critical"] as const;
export const AUTONOMY_ORDER = ["supervised", "shadow", "limited-unattended"] as const;
export const ENVIRONMENTS = ["shadow", "sandbox", "real"] as const;

export type Risk = (typeof RISK_ORDER)[number];
export type AutonomyTier = (typeof AUTONOMY_ORDER)[number];
export type Environment = (typeof ENVIRONMENTS)[number];

export interface CapabilityEntry {
  readonly id: string;
  readonly actor: string;
  readonly workspaceRoots: readonly string[];
  readonly operations: readonly string[];
  readonly riskLevel: Risk;
  readonly environment: Environment;
  readonly network: { readonly policy: "deny" | "allow"; readonly allowHosts?: readonly string[] };
  readonly maxAutonomyTier: AutonomyTier;
  readonly allowedTools: readonly string[];
  readonly allowedDelegationDepth: number;
  readonly budget: { readonly maxTokens: number; readonly maxToolCalls: number };
}

export interface CapabilityRegistry {
  readonly version: "1";
  readonly capabilities: readonly CapabilityEntry[];
}

export const DECISION = {
  ALLOW: "allow",
  REGISTRY_MISSING: "deny_registry_missing",
  REGISTRY_MALFORMED: "deny_registry_malformed",
  ENTRY_MALFORMED: "deny_entry_malformed",
  ACTOR_MISSING: "deny_actor_missing",
  ACTOR_WILDCARD: "deny_actor_wildcard",
  ACTOR_UNKNOWN: "deny_actor_unknown",
  WORKSPACE_MISMATCH: "deny_workspace_mismatch",
  OPERATION_MISMATCH: "deny_operation_mismatch",
  RISK_MISMATCH: "deny_risk_mismatch",
  ENVIRONMENT_MISMATCH: "deny_environment_mismatch",
  NETWORK_MISMATCH: "deny_network_mismatch",
  TOOL_MISMATCH: "deny_tool_mismatch",
  AUTONOMY_MISMATCH: "deny_autonomy_mismatch",
  DELEGATION_MISMATCH: "deny_delegation_mismatch",
} as const;

export type DecisionCode = (typeof DECISION)[keyof typeof DECISION];

export interface Decision {
  readonly allowed: boolean;
  readonly code: DecisionCode;
  readonly reason: string;
  readonly capabilityId: string | null;
}

export interface CapabilityRequest {
  readonly actor: string;
  readonly workspaceRoot: string;
  readonly operation: string;
  readonly riskLevel: Risk;
  readonly environment: Environment;
  readonly tool?: string;
  readonly autonomyTier?: AutonomyTier;
  readonly delegationDepth?: number;
  readonly network?: { readonly host?: string };
}

export type LoadResult =
  | { readonly ok: true; readonly registry: CapabilityRegistry }
  | { readonly ok: false; readonly code: DecisionCode; readonly reason: string };

function deny(code: DecisionCode, reason: string): Decision {
  return { allowed: false, code, reason, capabilityId: null };
}
function allow(capabilityId: string): Decision {
  return { allowed: true, code: DECISION.ALLOW, reason: "granted", capabilityId };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate one entry; returns an error reason or null. */
export function validateEntry(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "entry is not an object";
  const e = entry as Record<string, unknown>;
  if (!isNonEmptyString(e["id"])) return "missing id";
  const id = e["id"] as string;
  if (!isNonEmptyString(e["actor"])) return `entry ${id}: missing actor`;
  if ((e["actor"] as string).includes("*")) return `entry ${id}: wildcard actor not allowed`;
  if (!isStringArray(e["workspaceRoots"]) || (e["workspaceRoots"] as string[]).length === 0)
    return `entry ${id}: workspaceRoots must be a non-empty string[]`;
  if ((e["workspaceRoots"] as string[]).some((w) => !isNonEmptyString(w) || w.includes("*")))
    return `entry ${id}: workspaceRoots must be concrete absolute paths`;
  if (!isStringArray(e["operations"]) || (e["operations"] as string[]).length === 0)
    return `entry ${id}: operations must be a non-empty string[]`;
  if ((e["operations"] as string[]).includes("*")) return `entry ${id}: wildcard operation not allowed`;
  if (!RISK_ORDER.includes(e["riskLevel"] as Risk)) return `entry ${id}: invalid riskLevel`;
  if (!ENVIRONMENTS.includes(e["environment"] as Environment)) return `entry ${id}: invalid environment`;
  if (!AUTONOMY_ORDER.includes(e["maxAutonomyTier"] as AutonomyTier)) return `entry ${id}: invalid maxAutonomyTier`;
  const net = e["network"];
  if (net === null || typeof net !== "object") return `entry ${id}: missing network policy`;
  const n = net as Record<string, unknown>;
  if (n["policy"] !== "deny" && n["policy"] !== "allow") return `entry ${id}: network.policy must be deny|allow`;
  if (n["policy"] === "allow" && (!isStringArray(n["allowHosts"]) || (n["allowHosts"] as string[]).length === 0))
    return `entry ${id}: network.policy=allow requires a non-empty allowHosts[]`;
  if (!isStringArray(e["allowedTools"])) return `entry ${id}: allowedTools must be string[]`;
  if ((e["allowedTools"] as string[]).includes("*")) return `entry ${id}: wildcard tool not allowed`;
  const depth = e["allowedDelegationDepth"];
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0)
    return `entry ${id}: allowedDelegationDepth must be a non-negative integer`;
  const b = e["budget"];
  if (b === null || typeof b !== "object") return `entry ${id}: missing budget`;
  const bb = b as Record<string, unknown>;
  if (typeof bb["maxTokens"] !== "number" || bb["maxTokens"] < 0) return `entry ${id}: budget.maxTokens invalid`;
  if (typeof bb["maxToolCalls"] !== "number" || bb["maxToolCalls"] < 0) return `entry ${id}: budget.maxToolCalls invalid`;
  return null;
}

export function validateRegistry(parsed: unknown): LoadResult {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, code: DECISION.REGISTRY_MALFORMED, reason: "registry root is not an object" };
  const p = parsed as Record<string, unknown>;
  if (p["version"] !== "1")
    return { ok: false, code: DECISION.REGISTRY_MALFORMED, reason: `unsupported registry version: ${String(p["version"])}` };
  if (!Array.isArray(p["capabilities"]))
    return { ok: false, code: DECISION.REGISTRY_MALFORMED, reason: "capabilities must be an array" };
  const seen = new Set<string>();
  for (const entry of p["capabilities"] as unknown[]) {
    const err = validateEntry(entry);
    if (err) return { ok: false, code: DECISION.ENTRY_MALFORMED, reason: err };
    const id = (entry as Record<string, unknown>)["id"] as string;
    if (seen.has(id)) return { ok: false, code: DECISION.ENTRY_MALFORMED, reason: `duplicate capability id: ${id}` };
    seen.add(id);
  }
  return { ok: true, registry: parsed as CapabilityRegistry };
}

export function loadRegistry(path: string): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, code: DECISION.REGISTRY_MISSING, reason: `registry not found/readable: ${path}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: DECISION.REGISTRY_MALFORMED, reason: `registry is not valid JSON: ${(e as Error).message}` };
  }
  return validateRegistry(parsed);
}

function withinRoot(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}
function riskRank(level: Risk): number {
  return RISK_ORDER.indexOf(level);
}
function autonomyRank(tier: AutonomyTier): number {
  return AUTONOMY_ORDER.indexOf(tier);
}

/** Evaluate a request against a validated registry. DENY BY DEFAULT. */
export function evaluate(registry: CapabilityRegistry, request: CapabilityRequest): Decision {
  if (registry === null || typeof registry !== "object" || !Array.isArray(registry.capabilities))
    return deny(DECISION.REGISTRY_MALFORMED, "registry not validated");
  if (!isNonEmptyString(request.actor)) return deny(DECISION.ACTOR_MISSING, "actor missing/empty");
  if (request.actor.includes("*")) return deny(DECISION.ACTOR_WILDCARD, "wildcard actor denied in unattended mode");

  const caps = registry.capabilities.filter((c) => c.actor === request.actor);
  if (caps.length === 0) return deny(DECISION.ACTOR_UNKNOWN, `no capability grants for actor "${request.actor}"`);

  if (!isNonEmptyString(request.workspaceRoot)) return deny(DECISION.WORKSPACE_MISMATCH, "workspaceRoot missing");
  if (!isNonEmptyString(request.operation)) return deny(DECISION.OPERATION_MISMATCH, "operation missing");
  if (!RISK_ORDER.includes(request.riskLevel)) return deny(DECISION.RISK_MISMATCH, "request riskLevel invalid");
  if (!ENVIRONMENTS.includes(request.environment)) return deny(DECISION.ENVIRONMENT_MISMATCH, "request environment invalid");

  const reqTier: AutonomyTier = request.autonomyTier ?? "shadow";
  if (!AUTONOMY_ORDER.includes(reqTier)) return deny(DECISION.AUTONOMY_MISMATCH, "request autonomyTier invalid");
  const reqDepth = request.delegationDepth ?? 0;

  let lastDeny = deny(DECISION.OPERATION_MISMATCH, `actor "${request.actor}" has no grant covering this request`);
  for (const cap of caps) {
    if (!cap.workspaceRoots.some((root: string) => withinRoot(root, request.workspaceRoot))) {
      lastDeny = deny(DECISION.WORKSPACE_MISMATCH, `workspace not in cap ${cap.id} roots`);
      continue;
    }
    if (!cap.operations.includes(request.operation)) {
      lastDeny = deny(DECISION.OPERATION_MISMATCH, `operation "${request.operation}" not granted by cap ${cap.id}`);
      continue;
    }
    if (riskRank(request.riskLevel) > riskRank(cap.riskLevel)) {
      lastDeny = deny(DECISION.RISK_MISMATCH, `risk ${request.riskLevel} exceeds cap ${cap.id} ${cap.riskLevel}`);
      continue;
    }
    if (request.environment !== cap.environment) {
      lastDeny = deny(DECISION.ENVIRONMENT_MISMATCH, `environment mismatch for cap ${cap.id}`);
      continue;
    }
    if (autonomyRank(reqTier) > autonomyRank(cap.maxAutonomyTier)) {
      lastDeny = deny(DECISION.AUTONOMY_MISMATCH, `tier ${reqTier} exceeds cap ${cap.id} ${cap.maxAutonomyTier}`);
      continue;
    }
    if (reqDepth > cap.allowedDelegationDepth) {
      lastDeny = deny(DECISION.DELEGATION_MISMATCH, `delegation depth ${reqDepth} exceeds cap ${cap.id}`);
      continue;
    }
    if (isNonEmptyString(request.tool) && !cap.allowedTools.includes(request.tool)) {
      lastDeny = deny(DECISION.TOOL_MISMATCH, `tool "${request.tool}" not in cap ${cap.id} allowedTools`);
      continue;
    }
    const host = request.network?.host;
    if (isNonEmptyString(host)) {
      if (cap.network.policy !== "allow") {
        lastDeny = deny(DECISION.NETWORK_MISMATCH, `cap ${cap.id} denies network`);
        continue;
      }
      if (!(cap.network.allowHosts ?? []).includes(host)) {
        lastDeny = deny(DECISION.NETWORK_MISMATCH, `host "${host}" not in cap ${cap.id} allowHosts`);
        continue;
      }
    }
    return allow(cap.id);
  }
  return lastDeny;
}

/** Resolve the registry path: explicit arg → LAB_CAPABILITY_REGISTRY env → standard lab path. */
export function defaultRegistryPath(): string {
  const env = process.env["LAB_CAPABILITY_REGISTRY"];
  if (isNonEmptyString(env)) return env;
  return resolve(process.cwd(), "lab-capability", "registry.json");
}

/** Load from a path and evaluate in one call; any load failure is a fail-closed deny. */
export function loadAndEvaluate(path: string, request: CapabilityRequest): Decision {
  const loaded = loadRegistry(path);
  if (!loaded.ok) return deny(loaded.code, loaded.reason);
  return evaluate(loaded.registry, request);
}
