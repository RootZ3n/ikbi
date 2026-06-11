/**
 * ikbi agent identity — the config-driven agents registry.
 *
 * The roster of who-can-call is operator-controlled DATA, like the provider
 * roster. An unregistered caller has no identity — there is no default
 * (fail-closed).
 *
 * Security:
 *   - Credentials are stored as token HASHES, derived with a SALTED, slow KDF
 *     (scrypt) keyed by a pepper kept SEPARATE from the registry, so a stolen
 *     registry file resists offline brute force.
 *   - Tokens must meet a minimum entropy/length bar (machine-generated).
 *   - Trust tiers are a validated enum; `operator` tier is reserved for
 *     `kind: "operator"`.
 *   - Duplicate credentials across agents FAIL LOUD at load (no silent remap that
 *     could let one entry steal another's credential). Protected agents (the
 *     bootstrapped operator) cannot be overwritten.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

import { config } from "../config.js";
import type { IdentityKind, TailscalePeer } from "./contract.js";
import { IdentityError, isTrustTier, tierAllowedForKind } from "./contract.js";

const SCRYPT_KEYLEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** Minimum token length; tokens should be machine-generated high-entropy material. */
export const MIN_TOKEN_LENGTH = 24;

/**
 * Derive a token hash with a salted, slow KDF (scrypt + pepper). The pepper
 * defaults to `config.identity.tokenSalt` so registry hashes and auth lookups
 * agree; pass an explicit salt only in tests.
 */
export function hashToken(token: string, salt: string = config.identity.tokenSalt): string {
  return scryptSync(token, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString("hex");
}

/** Throw unless the token meets the minimum length + entropy bar. */
export function assertStrongToken(token: string): void {
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new IdentityError(
      "weak_token",
      `token must be at least ${MIN_TOKEN_LENGTH} characters of high-entropy material`,
    );
  }
  if (new Set(token).size < 8) {
    throw new IdentityError("weak_token", "token has insufficient entropy (too few distinct characters)");
  }
}

/** Generate a high-entropy agent token (256 bits, url-safe). The recommended way to mint tokens. */
export function generateAgentToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tailscale identities that authenticate an agent (any match authenticates). */
export interface TailscaleBinding {
  readonly logins?: readonly string[];
  readonly nodeIds?: readonly string[];
  readonly addrs?: readonly string[];
}

/** A registered agent (or the operator). */
export interface AgentRecord {
  readonly agentId: string;
  readonly kind: IdentityKind;
  /** What the agent does (populates AgentIdentity.functionalRole). */
  readonly functionalRole?: string;
  /** Registry-assigned default trust tier (validated enum; operator-coupled). */
  readonly defaultTrustTier: string;
  /** Accepted token hashes (KDF hex). */
  readonly tokenHashes?: readonly string[];
  /** Accepted Tailscale identities (matched only against boundary-verified peers). */
  readonly tailscale?: TailscaleBinding;
  /** If true, the agent exists but is refused (revocation without deletion). */
  readonly disabled?: boolean;
}

export interface AgentRegistryInit {
  readonly agents?: readonly AgentRecord[];
}

interface CredentialIndexes {
  readonly tokenHash: Map<string, string>;
  readonly login: Map<string, string>;
  readonly nodeId: Map<string, string>;
  readonly addr: Map<string, string>;
}

/** In-memory registry of agents with a read/update path and authenticated lookups. */
export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();
  private readonly locked = new Set<string>();
  private indexes: CredentialIndexes = emptyIndexes();

  constructor(init?: AgentRegistryInit) {
    for (const a of init?.agents ?? []) this.upsertAgent(a);
  }

  // --- read ---
  getAgent(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }
  listAgents(): AgentRecord[] {
    return [...this.agents.values()];
  }

  // --- update (transactional: indexes are recomputed and validated before commit) ---
  upsertAgent(record: AgentRecord, opts?: { locked?: boolean }): void {
    validateRecord(record);
    if (this.locked.has(record.agentId) && opts?.locked !== true) {
      throw new IdentityError("registry", `agent "${record.agentId}" is protected and cannot be overwritten`);
    }
    const next = new Map(this.agents);
    next.set(record.agentId, record);
    const indexes = computeIndexes(next.values()); // throws on duplicate credential
    this.agents = next;
    this.indexes = indexes;
    if (opts?.locked === true) this.locked.add(record.agentId);
  }

  removeAgent(id: string): boolean {
    if (!this.agents.has(id)) return false;
    if (this.locked.has(id)) {
      throw new IdentityError("registry", `agent "${id}" is protected and cannot be deleted`);
    }
    const next = new Map(this.agents);
    next.delete(id);
    this.agents = next;
    this.indexes = computeIndexes(next.values());
    return true;
  }

  // --- authenticated lookups ---
  findByTokenHash(tokenHash: string): AgentRecord | undefined {
    const id = this.indexes.tokenHash.get(tokenHash);
    return id !== undefined ? this.agents.get(id) : undefined;
  }

  findByTailscale(peer: TailscalePeer): AgentRecord | undefined {
    if (peer.nodeId !== undefined) {
      const id = this.indexes.nodeId.get(peer.nodeId);
      if (id !== undefined) return this.agents.get(id);
    }
    if (peer.login !== undefined) {
      const id = this.indexes.login.get(peer.login.toLowerCase());
      if (id !== undefined) return this.agents.get(id);
    }
    if (peer.addr !== undefined) {
      const id = this.indexes.addr.get(peer.addr);
      if (id !== undefined) return this.agents.get(id);
    }
    return undefined;
  }

  /** Merge a JSON registry file. Missing file => no-op; malformed/duplicate => throws (fail loud). */
  loadRegistryFile(path: string): { agents: number } {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return { agents: 0 };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (cause) {
      throw new IdentityError("registry", `invalid JSON in agents registry ${path}: ${String(cause)}`);
    }
    return this.applyRegistry(doc, path);
  }

  /** Apply a parsed registry document (also usable directly in tests). */
  applyRegistry(doc: unknown, source = "<inline>"): { agents: number } {
    if (typeof doc !== "object" || doc === null) {
      throw new IdentityError("registry", `agents registry ${source} must be a JSON object`);
    }
    const root = doc as Record<string, unknown>;
    const list = root.agents;
    if (list === undefined) return { agents: 0 };
    if (!Array.isArray(list)) {
      throw new IdentityError("registry", `agents registry ${source}: "agents" must be an array`);
    }
    let count = 0;
    for (const entry of list) {
      this.upsertAgent(parseAgentRecord(entry, source));
      count += 1;
    }
    return { agents: count };
  }
}

// ---------------------------------------------------------------------------
// Indexing (fail loud on duplicate credentials)
// ---------------------------------------------------------------------------

function emptyIndexes(): CredentialIndexes {
  return { tokenHash: new Map(), login: new Map(), nodeId: new Map(), addr: new Map() };
}

function computeIndexes(records: Iterable<AgentRecord>): CredentialIndexes {
  const indexes = emptyIndexes();
  const claim = (map: Map<string, string>, key: string, agentId: string, what: string): void => {
    const existing = map.get(key);
    if (existing !== undefined && existing !== agentId) {
      throw new IdentityError(
        "registry",
        `duplicate ${what} credential shared by agents "${existing}" and "${agentId}" — refusing to load`,
      );
    }
    map.set(key, agentId);
  };
  for (const rec of records) {
    for (const h of rec.tokenHashes ?? []) claim(indexes.tokenHash, h, rec.agentId, "token");
    for (const l of rec.tailscale?.logins ?? []) claim(indexes.login, l.toLowerCase(), rec.agentId, "tailscale login");
    for (const n of rec.tailscale?.nodeIds ?? []) claim(indexes.nodeId, n, rec.agentId, "tailscale nodeId");
    for (const a of rec.tailscale?.addrs ?? []) claim(indexes.addr, a, rec.agentId, "tailscale addr");
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Validation / parsing
// ---------------------------------------------------------------------------

function validateRecord(rec: AgentRecord): void {
  if (typeof rec.agentId !== "string" || rec.agentId.length === 0) {
    throw new IdentityError("registry", `agent record has an invalid agentId`);
  }
  if (rec.kind !== "operator" && rec.kind !== "agent") {
    throw new IdentityError("registry", `agent "${rec.agentId}" has invalid kind "${String(rec.kind)}"`);
  }
  if (!isTrustTier(rec.defaultTrustTier)) {
    throw new IdentityError(
      "invalid_tier",
      `agent "${rec.agentId}" has invalid trust tier "${String(rec.defaultTrustTier)}"`,
    );
  }
  if (!tierAllowedForKind(rec.defaultTrustTier, rec.kind)) {
    throw new IdentityError(
      "invalid_tier",
      `agent "${rec.agentId}" (kind=${rec.kind}) cannot carry the "operator" trust tier — it is reserved for the operator`,
    );
  }
  for (const h of rec.tokenHashes ?? []) {
    if (!/^[a-f0-9]{64}$/.test(h)) {
      throw new IdentityError("registry", `agent "${rec.agentId}" has a malformed token hash`);
    }
  }
}

function asStringArray(v: unknown, what: string, source: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new IdentityError("registry", `${what} in ${source} must be an array of strings`);
  }
  return v as string[];
}

function parseAgentRecord(v: unknown, source: string): AgentRecord {
  if (typeof v !== "object" || v === null) {
    throw new IdentityError("registry", `agent entry in ${source} must be an object`);
  }
  const r = v as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== "operator" && kind !== "agent") {
    throw new IdentityError("registry", `agent entry in ${source} has invalid kind "${String(kind)}"`);
  }

  let tailscale: TailscaleBinding | undefined;
  if (r.tailscale !== undefined) {
    if (typeof r.tailscale !== "object" || r.tailscale === null) {
      throw new IdentityError("registry", `agent.tailscale in ${source} must be an object`);
    }
    const t = r.tailscale as Record<string, unknown>;
    const logins = asStringArray(t.logins, "tailscale.logins", source);
    const nodeIds = asStringArray(t.nodeIds, "tailscale.nodeIds", source);
    const addrs = asStringArray(t.addrs, "tailscale.addrs", source);
    tailscale = {
      ...(logins ? { logins } : {}),
      ...(nodeIds ? { nodeIds } : {}),
      ...(addrs ? { addrs } : {}),
    };
  }

  const tokenHashes = asStringArray(r.tokenHashes, "tokenHashes", source);
  const record: AgentRecord = {
    agentId: typeof r.agentId === "string" ? r.agentId : "",
    kind: kind as IdentityKind,
    defaultTrustTier: typeof r.defaultTrustTier === "string" ? r.defaultTrustTier : "",
    ...(typeof r.functionalRole === "string" ? { functionalRole: r.functionalRole } : {}),
    ...(tokenHashes ? { tokenHashes } : {}),
    ...(tailscale ? { tailscale } : {}),
    ...(typeof r.disabled === "boolean" ? { disabled: r.disabled } : {}),
  };
  validateRecord(record);
  return record;
}
