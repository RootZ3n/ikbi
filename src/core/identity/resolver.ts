/**
 * ikbi agent identity — the resolver and the runtime-unforgeable ValidatedIdentity.
 *
 * `ValidatedIdentity` is genuinely unforgeable at RUNTIME, not just in the type
 * system:
 *   - Its class is NOT exported (only the type is), its constructor is guarded by
 *     a module-private key, and `mint` is a module-private function — so no
 *     external import can construct or mint one.
 *   - The source of truth is a module-private `WeakSet` of genuinely-minted
 *     identities. `isValidatedIdentity` verifies membership, so a forged plain
 *     object / `as any` cast / deserialized object FAILS at runtime even if it
 *     structurally matches.
 *
 * FAIL-CLOSED: any resolution failure throws a typed `IdentityError`; nothing is
 * ever defaulted to an identity. A claim's `claimedAgentId` is advisory; Tailscale
 * identity is taken ONLY from the boundary-verified peer, never from the claim.
 */

import type { Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import type {
  AuthMethod,
  IdentityClaim,
  IdentityErrorKind,
  IdentityKind,
  TrustTierResolver,
  VerifiedPeer,
} from "./contract.js";
import {
  IDENTITY_CONTRACT_VERSION,
  IdentityError,
  isTrustTier,
  staticTrustTierResolver,
  tierAllowedForKind,
} from "./contract.js";
import { type AgentRecord, AgentRegistry, hashToken } from "./registry.js";

// ---------------------------------------------------------------------------
// ValidatedIdentity — runtime-unforgeable
// ---------------------------------------------------------------------------

/** Module-private key guarding construction. Never exported. */
const MINT_KEY: unique symbol = Symbol("ikbi.identity.mint");

/** Module-private runtime source of truth: genuinely-minted identities. */
const minted = new WeakSet<object>();

interface ValidatedParts {
  readonly kind: IdentityKind;
  readonly identity: AgentIdentity;
  readonly authMethod: AuthMethod;
  readonly resolvedAt: number;
}

/** The concrete class. NOT exported as a value — only its type is (below). */
class ValidatedIdentityImpl {
  readonly #brand = true;
  readonly contractVersion: string = IDENTITY_CONTRACT_VERSION;
  readonly kind: IdentityKind;
  readonly identity: AgentIdentity;
  readonly authMethod: AuthMethod;
  readonly resolvedAt: number;

  constructor(key: symbol, parts: ValidatedParts) {
    if (key !== MINT_KEY) {
      throw new IdentityError("registry", "ValidatedIdentity cannot be constructed externally");
    }
    this.kind = parts.kind;
    this.identity = Object.freeze({ ...parts.identity });
    this.authMethod = parts.authMethod;
    this.resolvedAt = parts.resolvedAt;
    Object.freeze(this);
  }

  /** Private-field brand check — distinguishes genuine instances from look-alikes. */
  static brandPresent(o: object): boolean {
    return #brand in o;
  }
}

/** The public, opaque type. Consumers can hold/read but never construct one. */
export type ValidatedIdentity = ValidatedIdentityImpl;

/** Module-private mint — the ONLY path to a ValidatedIdentity. Not exported. */
function mint(parts: ValidatedParts): ValidatedIdentity {
  const v = new ValidatedIdentityImpl(MINT_KEY, parts);
  minted.add(v);
  return v;
}

/**
 * Runtime check that a value is a genuinely-minted ValidatedIdentity. The WeakSet
 * is the source of truth (resolver-owned); the private-field brand is a secondary
 * guard. Subsystems that require a validated identity MUST gate on this — never
 * trust a structural shape.
 */
export function isValidatedIdentity(o: unknown): o is ValidatedIdentity {
  if (typeof o !== "object" || o === null) return false;
  return ValidatedIdentityImpl.brandPresent(o) && minted.has(o);
}

/** True if the validated identity is the human operator. */
export function isOperator(v: ValidatedIdentity): boolean {
  return v.kind === "operator";
}

// ---------------------------------------------------------------------------
// Immutable carry + revocation seam
// ---------------------------------------------------------------------------

/** The immutable carry for one operation; threads through every subsystem. */
export interface OperationContext {
  readonly contractVersion: string;
  readonly identity: ValidatedIdentity;
  readonly requestId?: string;
  readonly startedAt: number;
  /**
   * Dry-run / plan-only SEAM (Step S). When true, a side-effecting module MUST
   * COMPUTE and REPORT the change it WOULD make, and SKIP the irreversible action
   * (no writes, no spawns, no network mutations, no commits). Additive + optional:
   * `undefined` means a normal (executing) operation. This is the CONVENTION only —
   * the engine threads the flag immutably; each module is responsible for honoring
   * it. The dry-run/plan-only MODULE (a later leaf) builds the reporting surface on
   * top of this seam.
   */
  readonly dryRun?: boolean;
}

/** Result of re-checking whether an established identity is still valid. */
export interface RevalidationResult {
  readonly valid: boolean;
  readonly reason?: IdentityErrorKind;
}

/** Trusted, boundary-only context for resolution (NOT client-submittable). */
export interface ResolveContext {
  /** Correlation id for logs/receipts. */
  readonly requestId?: string;
  /** Boundary-VERIFIED peer (e.g. Tailscale whois). The only trusted peer source. */
  readonly verifiedPeer?: VerifiedPeer;
  /**
   * For a deterministically-spawned subagent: the spawning parent's agentId.
   * Trusted (set by the spawn module), never from the client claim. Carried onto
   * AgentIdentity.spawnedFrom.
   */
  readonly spawnedFrom?: string;
}

export interface IdentityResolverDeps {
  readonly registry: AgentRegistry;
  readonly logger: Logger;
  /** Trust-tier seam. Defaults to the static (registry-tier) resolver. */
  readonly trustResolver?: TrustTierResolver;
  /** Clock (ms epoch). Defaults to Date.now. */
  readonly now?: () => number;
}

export class IdentityResolver {
  private readonly registry: AgentRegistry;
  private readonly log: Logger;
  private readonly trustResolver: TrustTierResolver;
  private readonly now: () => number;

  constructor(deps: IdentityResolverDeps) {
    this.registry = deps.registry;
    this.log = deps.logger;
    this.trustResolver = deps.trustResolver ?? staticTrustTierResolver;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Resolve a (client) claim + (trusted) context to a validated identity, or
   * throw a typed IdentityError. Logs success and rejection.
   */
  resolve(claim: IdentityClaim, ctx?: ResolveContext): ValidatedIdentity {
    try {
      const { record, method } = this.authenticate(claim, ctx?.verifiedPeer);
      const trustTier = this.resolveTier(record);

      const identity: AgentIdentity = {
        agentId: record.agentId,
        ...(record.functionalRole !== undefined ? { functionalRole: record.functionalRole } : {}),
        trustTier,
        ...(claim.sessionId !== undefined ? { sessionId: claim.sessionId } : {}),
        ...(ctx?.spawnedFrom !== undefined ? { spawnedFrom: ctx.spawnedFrom } : {}),
      };

      const validated = mint({ kind: record.kind, identity, authMethod: method, resolvedAt: this.now() });

      this.log.info(
        {
          event: "identity_resolved",
          outcome: "authenticated",
          agentId: record.agentId,
          kind: record.kind,
          functionalRole: record.functionalRole,
          trustTier,
          authMethod: method,
          spawnedFrom: ctx?.spawnedFrom,
          requestId: ctx?.requestId,
          remoteAddr: claim.remoteAddr ?? ctx?.verifiedPeer?.remoteAddr,
          claimedAgentId: claim.claimedAgentId,
        },
        "identity resolved",
      );
      return validated;
    } catch (err) {
      const reason = err instanceof IdentityError ? err.kind : "registry";
      this.log.warn(
        {
          event: "identity_rejected",
          outcome: "rejected",
          reason,
          requestId: ctx?.requestId,
          remoteAddr: claim.remoteAddr ?? ctx?.verifiedPeer?.remoteAddr,
          claimedAgentId: claim.claimedAgentId,
          hadToken: claim.token !== undefined && claim.token.length > 0,
          hadVerifiedPeer: ctx?.verifiedPeer?.tailscale !== undefined,
        },
        "identity rejected (fail-closed)",
      );
      throw err;
    }
  }

  /**
   * Revocation seam: re-check that an established identity is still valid against
   * the current registry. A long-running OperationContext calls this periodically
   * so that disabling/removing an agent can eventually halt in-flight work.
   * (This phase builds the seam; enforced halting wires in later.)
   */
  revalidate(identity: ValidatedIdentity): RevalidationResult {
    const rec = this.registry.getAgent(identity.identity.agentId);
    if (rec === undefined) return { valid: false, reason: "unknown_agent" };
    if (rec.disabled === true) return { valid: false, reason: "disabled_agent" };
    return { valid: true };
  }

  /** Authenticate: token from the (untrusted) claim; Tailscale ONLY from the verified peer. */
  private authenticate(
    claim: IdentityClaim,
    verifiedPeer: VerifiedPeer | undefined,
  ): { record: AgentRecord; method: AuthMethod } {
    if (claim.token !== undefined && claim.token.length > 0) {
      const record = this.registry.findByTokenHash(hashToken(claim.token));
      if (record === undefined) {
        throw new IdentityError("invalid_credential", "presented token does not match any registered agent");
      }
      if (record.disabled === true) {
        throw new IdentityError("disabled_agent", `agent "${record.agentId}" is disabled`);
      }
      return { record, method: record.kind === "operator" ? "operator_token" : "agent_token" };
    }

    // Tailscale identity is trusted ONLY from the boundary-verified peer.
    if (verifiedPeer?.tailscale !== undefined) {
      const record = this.registry.findByTailscale(verifiedPeer.tailscale);
      if (record === undefined) {
        throw new IdentityError("unknown_agent", "verified tailscale peer is not mapped to a registered agent");
      }
      if (record.disabled === true) {
        throw new IdentityError("disabled_agent", `agent "${record.agentId}" is disabled`);
      }
      return { record, method: "tailscale_peer" };
    }

    throw new IdentityError(
      "unauthenticated",
      "no credential presented (agent token, or a boundary-verified tailscale peer, required)",
    );
  }

  /** Resolve the trust tier via the seam, then re-validate it (defense at resolve). */
  private resolveTier(record: AgentRecord): string {
    const proposed = this.trustResolver.resolve({
      agentId: record.agentId,
      kind: record.kind,
      defaultTrustTier: record.defaultTrustTier,
    });
    // A misbehaving trust plug-in must never escalate: clamp to the (validated)
    // registry default if it returns a non-enum tier or an operator tier for a
    // non-operator agent.
    if (!isTrustTier(proposed) || !tierAllowedForKind(proposed, record.kind)) {
      this.log.warn(
        { event: "trust_tier_clamped", agentId: record.agentId, kind: record.kind, proposed, clampedTo: record.defaultTrustTier },
        "trust resolver returned an invalid/escalating tier; clamped to registry default",
      );
      return record.defaultTrustTier;
    }
    return proposed;
  }
}

/**
 * Begin an operation: wrap a validated identity in the immutable carry envelope.
 * Frozen — it cannot be changed mid-flight.
 */
export function beginOperation(
  identity: ValidatedIdentity,
  opts?: { requestId?: string; now?: number; dryRun?: boolean },
): OperationContext {
  return Object.freeze({
    contractVersion: IDENTITY_CONTRACT_VERSION,
    identity,
    ...(opts?.requestId !== undefined ? { requestId: opts.requestId } : {}),
    startedAt: opts?.now ?? Date.now(),
    ...(opts?.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
  });
}
