/**
 * ikbi provider layer — config-driven model & provider registry.
 *
 * The roster (which models exist, their cost rates, and their ordered provider
 * fallback routes) is DATA, not code: edit the JSON roster file or call the
 * upsert/remove API and the roster changes with no code change. Built-in
 * defaults seed mimo-v2.5 (driver) and mimo-v2.5-pro (critic); the file (if
 * present) upserts/extends them and may declare additional providers.
 */

import { readFileSync } from "node:fs";

import type { CostRate, ModelProvider } from "./contract.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";

/** One step in a model's ordered fallback chain: which provider, what model id to send. */
export interface ProviderRoute {
  readonly provider: string;
  readonly providerModelId: string;
  /**
   * Per-(provider+model) cost rate. The same logical model may cost differently
   * on different providers, so cost is keyed at the route. Falls back to the
   * model-level `cost` when omitted. Accounting uses the rate of the route that
   * actually served (so a fallback is priced at the backup's rate).
   */
  readonly cost?: CostRate;
}

/** A model entry in the roster. */
export interface ModelSpec {
  /** Logical id used in requests (e.g. "mimo-v2.5"). */
  readonly id: string;
  /** Optional roster role label for the model ("driver", "critic", ...). */
  readonly role?: string;
  /** Default per-1M-token cost rate, used for any route that omits its own. */
  readonly cost?: CostRate;
  /** Ordered provider routes — the deterministic fallback chain for this model. */
  readonly providers: readonly ProviderRoute[];
}

/** Resolve the effective cost rate for a served route (route rate beats model default). */
export function resolveRate(model: ModelSpec, route: ProviderRoute): CostRate {
  return route.cost ?? model.cost ?? { promptPerMTok: 0, completionPerMTok: 0 };
}

export interface RegistryInit {
  readonly models?: readonly ModelSpec[];
  readonly providers?: readonly ModelProvider[];
}

/** In-memory registry of models and provider instances, with a read/update path. */
export class ModelRegistry {
  private readonly models = new Map<string, ModelSpec>();
  private readonly providers = new Map<string, ModelProvider>();

  constructor(init?: RegistryInit) {
    for (const m of init?.models ?? []) this.upsertModel(m);
    for (const p of init?.providers ?? []) this.registerProvider(p);
  }

  // --- models (read) ---
  getModel(id: string): ModelSpec | undefined {
    return this.models.get(id);
  }
  listModels(): ModelSpec[] {
    return [...this.models.values()];
  }

  // --- models (update) ---
  upsertModel(spec: ModelSpec): void {
    this.models.set(spec.id, spec);
  }
  removeModel(id: string): boolean {
    return this.models.delete(id);
  }

  // --- providers (read) ---
  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }
  listProviders(): ModelProvider[] {
    return [...this.providers.values()];
  }

  // --- providers (update) ---
  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }
  removeProvider(id: string): boolean {
    return this.providers.delete(id);
  }

  /**
   * Merge a JSON roster file. Validates shape and upserts models / providers.
   * Returns the number of models and providers applied. Missing file => no-op.
   * Malformed file => throws (fail loud — the roster is operationally critical).
   */
  loadRosterFile(path: string): { models: number; providers: number } {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return { models: 0, providers: 0 }; // absent file is fine
    }

    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`Invalid JSON in provider roster file ${path}: ${String(cause)}`);
    }
    return this.applyRoster(doc, path);
  }

  /** Apply a parsed roster document (also usable directly in tests). */
  applyRoster(doc: unknown, source = "<inline>"): { models: number; providers: number } {
    if (typeof doc !== "object" || doc === null) {
      throw new Error(`Provider roster ${source} must be a JSON object`);
    }
    const root = doc as Record<string, unknown>;

    let providers = 0;
    if (root.providers !== undefined) {
      if (!Array.isArray(root.providers)) {
        throw new Error(`Provider roster ${source}: "providers" must be an array`);
      }
      for (const entry of root.providers) {
        this.registerProvider(parseProviderEntry(entry, source));
        providers += 1;
      }
    }

    let models = 0;
    if (root.models !== undefined) {
      if (!Array.isArray(root.models)) {
        throw new Error(`Provider roster ${source}: "models" must be an array`);
      }
      for (const entry of root.models) {
        this.upsertModel(parseModelSpec(entry, source));
        models += 1;
      }
    }

    return { models, providers };
  }
}

// ---------------------------------------------------------------------------
// Roster file parsing/validation
// ---------------------------------------------------------------------------

function asRecord(v: unknown, what: string, source: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null) {
    throw new Error(`Provider roster ${source}: ${what} must be an object`);
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, what: string, source: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Provider roster ${source}: ${what} must be a non-empty string`);
  }
  return v;
}

function asNumber(v: unknown, what: string, source: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error(`Provider roster ${source}: ${what} must be a non-negative number`);
  }
  return v;
}

function parseCostRateMaybe(v: unknown, source: string): CostRate | undefined {
  if (v === undefined) return undefined;
  const r = asRecord(v, "cost", source);
  const rate: CostRate = {
    promptPerMTok: asNumber(r.promptPerMTok, "cost.promptPerMTok", source),
    completionPerMTok: asNumber(r.completionPerMTok, "cost.completionPerMTok", source),
    ...(r.cachedPromptPerMTok !== undefined
      ? { cachedPromptPerMTok: asNumber(r.cachedPromptPerMTok, "cost.cachedPromptPerMTok", source) }
      : {}),
  };
  return rate;
}

function parseModelSpec(v: unknown, source: string): ModelSpec {
  const r = asRecord(v, "model", source);
  const id = asString(r.id, "model.id", source);
  const routesRaw = r.providers;
  if (!Array.isArray(routesRaw) || routesRaw.length === 0) {
    throw new Error(`Provider roster ${source}: model.providers must be a non-empty array`);
  }
  const modelCost = parseCostRateMaybe(r.cost, source);
  const providers: ProviderRoute[] = routesRaw.map((route) => {
    const rr = asRecord(route, "model.providers[]", source);
    const routeCost = parseCostRateMaybe(rr.cost, source);
    // Every route must resolve to a rate (its own or the model default).
    if (routeCost === undefined && modelCost === undefined) {
      throw new Error(
        `Provider roster ${source}: model "${id}" route has no cost rate (set route.cost or model.cost)`,
      );
    }
    return {
      provider: asString(rr.provider, "route.provider", source),
      providerModelId: asString(rr.providerModelId, "route.providerModelId", source),
      ...(routeCost !== undefined ? { cost: routeCost } : {}),
    };
  });
  const role = r.role;
  return {
    id,
    ...(typeof role === "string" ? { role } : {}),
    ...(modelCost !== undefined ? { cost: modelCost } : {}),
    providers,
  };
}

function parseProviderEntry(v: unknown, source: string): ModelProvider {
  const r = asRecord(v, "provider", source);
  const kind = r.kind ?? "openai-compatible";
  if (kind !== "openai-compatible") {
    throw new Error(`Provider roster ${source}: unsupported provider kind "${String(kind)}"`);
  }
  const headersRaw = r.headers;
  const extraHeaders: Record<string, string> = {};
  if (headersRaw !== undefined) {
    const hr = asRecord(headersRaw, "provider.headers", source);
    for (const [k, val] of Object.entries(hr)) extraHeaders[k] = String(val);
  }
  const apiKey = typeof r.apiKey === "string" ? r.apiKey : undefined;
  return new OpenAICompatibleProvider({
    id: asString(r.id, "provider.id", source),
    baseUrl: asString(r.baseUrl, "provider.baseUrl", source),
    apiKey,
    extraHeaders,
  });
}
