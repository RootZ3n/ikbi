/**
 * ikbi agent identity / multi-tenancy — THE FROZEN CONTRACT (#3).
 *
 * Every operation in the engine is attributable to an identity — a specific
 * agent or the human operator. This layer ESTABLISHES identity at the entry
 * boundary, VALIDATES it against the agents registry, and CARRIES it immutably.
 *
 * It does NOT redefine the identity shape: `AgentIdentity` is the frozen type
 * from the provider contract — imported, never re-declared. This phase populates
 * and enforces it.
 *
 * Security posture (the threat is spoofing / escalation):
 *   - FAIL-CLOSED: no operation defaults to an identity. A caller that does not
 *     authenticate is rejected with a typed error.
 *   - CLAIM vs VERIFIED vs VALIDATED. An `IdentityClaim` is client-submittable
 *     and fully untrusted. A `VerifiedPeer` is boundary-verified (the server,
 *     e.g. via Tailscale whois) and is the ONLY trusted source of peer identity —
 *     clients cannot assert it. A `ValidatedIdentity` (see resolver) is the
 *     resolver's runtime-unforgeable proof that authentication succeeded.
 *   - Identity, once validated, is immutable; trust tier is set once, here, from
 *     the registry — never by the caller.
 *
 * Notes:
 *   - `trustTier` models AGENT trust only. Model/provider trust is the
 *     shadow-workspace module's separate concern — do not overload it here.
 *   - `sessionId` is the canonical multi-turn correlation key.
 */

import type { AgentIdentity } from "../provider/contract.js";

/**
 * Semantic version of the identity contract.
 *
 * 1.1.0 — additive: `OperationContext.dryRun` (the dry-run/plan-only seam, Step S).
 *         A new OPTIONAL field → MINOR bump per the codified compatibility rule;
 *         modules pinning identity@1.0.x stay compatible (they ignore the field).
 * 1.0.0 — frozen-core identity contract.
 */
export const IDENTITY_CONTRACT_VERSION = "1.1.0";

/** Whether the caller is the human operator or an (autonomous) agent. */
export type IdentityKind = "operator" | "agent";

/** How an identity was authenticated — provenance recorded for the audit trail. */
export type AuthMethod = "agent_token" | "operator_token" | "tailscale_peer";

// ---------------------------------------------------------------------------
// Trust tiers — a VALIDATED ENUM, not an arbitrary string
// ---------------------------------------------------------------------------

/** Canonical trust tiers, highest -> lowest. `operator` is reserved for kind "operator". */
export const TRUST_TIERS = ["operator", "trusted", "verified", "probation", "untrusted"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/** Runtime guard: is `s` one of the canonical trust tiers? */
export function isTrustTier(s: string): s is TrustTier {
  return (TRUST_TIERS as readonly string[]).includes(s);
}

/**
 * Whether `tier` is permitted for `kind`. The `operator` tier is reserved for
 * `kind: "operator"` — an agent record can never carry operator tier, regardless
 * of what its `defaultTrustTier` says. Enforced at registry load AND at resolve.
 */
export function tierAllowedForKind(tier: string, kind: IdentityKind): boolean {
  if (!isTrustTier(tier)) return false;
  if (tier === "operator") return kind === "operator";
  return true;
}

// ---------------------------------------------------------------------------
// Claim (UNTRUSTED) vs VerifiedPeer (TRUSTED)
// ---------------------------------------------------------------------------

/** A Tailscale peer descriptor. Only ever populated from a boundary-verified source. */
export interface TailscalePeer {
  /** Tailnet login / user (e.g. "alice@example.com"). */
  readonly login?: string;
  /** Stable node identifier (node key / stable id). */
  readonly nodeId?: string;
  /** Peer address within the tailnet. */
  readonly addr?: string;
}

/**
 * A raw, UNVALIDATED, client-submittable identity claim. Everything here is
 * attacker-controllable. `claimedAgentId` is advisory only and can never select
 * or escalate an identity. NOTE: there is deliberately NO Tailscale field here —
 * peer identity is NOT client-assertable; it must come via `VerifiedPeer`.
 */
export interface IdentityClaim {
  /** Bearer/agent token presented by the caller, if any. */
  readonly token?: string;
  /** Agent id the caller claims to be (advisory; never trusted). */
  readonly claimedAgentId?: string;
  /** Remote address, for logging only. */
  readonly remoteAddr?: string;
  /** Canonical multi-turn correlation key to carry onto the identity. */
  readonly sessionId?: string;
}

/**
 * Boundary-VERIFIED peer information. The server populates this from a trusted
 * source (e.g. `tailscale whois` on the peer connection) — it MUST NOT be filled
 * from any client-submitted data. The resolver authenticates a Tailscale
 * identity ONLY from here, never from `IdentityClaim`, so a client cannot forge
 * a peer identity.
 */
export interface VerifiedPeer {
  readonly tailscale?: TailscalePeer;
  readonly remoteAddr?: string;
}

// ---------------------------------------------------------------------------
// trustTier establishment seam (the dynamic-trust phase plugs in here)
// ---------------------------------------------------------------------------

export interface TrustTierInput {
  readonly agentId: string;
  readonly kind: IdentityKind;
  /** The registry-assigned (already-validated) default tier for this agent. */
  readonly defaultTrustTier: string;
}

/**
 * Seam for trust-tier assignment. This phase sets up WHERE the tier is decided;
 * the dynamic trust system (a later phase) implements behavior-based adjustment
 * by providing its own resolver. The resolver re-validates the returned tier
 * (enum + operator coupling) so a misbehaving plug-in can never escalate.
 */
export interface TrustTierResolver {
  resolve(input: TrustTierInput): string;
}

/** Default resolver: the agent's registry tier, unchanged. */
export const staticTrustTierResolver: TrustTierResolver = {
  resolve: (input) => input.defaultTrustTier,
};

// ---------------------------------------------------------------------------
// Typed errors (fail-closed)
// ---------------------------------------------------------------------------

export type IdentityErrorKind =
  | "unauthenticated" // no credential presented
  | "unknown_agent" // credential/peer not mapped to a registered agent
  | "invalid_credential" // token presented but does not match
  | "disabled_agent" // agent exists but is disabled
  | "invalid_tier" // a trust tier failed enum / operator-coupling validation
  | "weak_token" // a token failed the minimum entropy/length requirement
  | "registry"; // registry file/data problem (incl. duplicate credentials)

/** A typed identity-resolution failure. Resolution is fail-closed: it throws, never defaults. */
export class IdentityError extends Error {
  readonly kind: IdentityErrorKind;
  constructor(kind: IdentityErrorKind, message: string) {
    super(message);
    this.name = "IdentityError";
    this.kind = kind;
  }
}

/** Re-exported for convenience: the frozen AgentIdentity shape this layer populates. */
export type { AgentIdentity };
