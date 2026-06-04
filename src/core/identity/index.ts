/**
 * ikbi agent identity / multi-tenancy — public surface (frozen contract #3).
 *
 * The boundary resolves an incoming request to a validated identity:
 *
 *     const who = resolveIdentity({ token, remoteAddr }, { verifiedPeer, requestId });
 *     const ctx = beginOperation(who, { requestId });
 *     // ctx.identity.identity is the frozen AgentIdentity for provider/injection/receipts
 *
 * `token` comes from the (untrusted) client claim; the Tailscale `verifiedPeer`
 * comes ONLY from the trusted server boundary. The default registry + resolver
 * are wired from `config`: the operator is bootstrapped from `IKBI_OPERATOR_TOKEN`
 * (strength-checked, hashed, PROTECTED), then the agents registry file is applied.
 * Fail-closed: no caller is ever defaulted to an identity.
 *
 * `ValidatedIdentity` is runtime-unforgeable — only the resolver mints one, and
 * `isValidatedIdentity` is the runtime gate. The mint function is not exported.
 */

import { config } from "../config.js";
import { childLogger } from "../log.js";
import { IdentityResolver } from "./resolver.js";
import { AgentRegistry, assertStrongToken, hashToken } from "./registry.js";
import type { IdentityClaim } from "./contract.js";
import type { ResolveContext, ValidatedIdentity } from "./resolver.js";

const log = childLogger("identity");

/** Build the default agents registry: operator bootstrap (protected) + registry file. */
function buildDefaultRegistry(): AgentRegistry {
  const ic = config.identity;
  const registry = new AgentRegistry();

  if (ic.tokenSaltIsDefault) {
    log.warn(
      {},
      "IKBI_IDENTITY_TOKEN_SALT is unset — using the insecure built-in token-hash pepper; set it in production",
    );
  }

  if (ic.operatorToken !== undefined) {
    assertStrongToken(ic.operatorToken); // fail loud on a weak operator token
    registry.upsertAgent(
      {
        agentId: ic.operatorAgentId,
        kind: "operator",
        functionalRole: "operator",
        defaultTrustTier: "operator",
        tokenHashes: [hashToken(ic.operatorToken)],
      },
      { locked: true }, // PROTECTED: a registry-file entry cannot overwrite the operator
    );
    log.info({ operatorAgentId: ic.operatorAgentId }, "bootstrapped protected operator identity from IKBI_OPERATOR_TOKEN");
  }

  try {
    const applied = registry.loadRegistryFile(ic.registryFile);
    if (applied.agents > 0) log.info({ ...applied, file: ic.registryFile }, "applied agents registry file");
  } catch (err) {
    log.error({ err, file: ic.registryFile }, "failed to load agents registry file");
    throw err;
  }

  if (registry.listAgents().length === 0) {
    log.warn(
      { registryFile: ic.registryFile },
      "no agents registered — all callers will be rejected (fail-closed) until agents are added",
    );
  }
  return registry;
}

/** The process-wide agents registry (read/update path for who-can-call). */
export const registry: AgentRegistry = buildDefaultRegistry();

/** The process-wide identity resolver. */
export const resolver = new IdentityResolver({ registry, logger: log });

/** Resolve an incoming claim (+ trusted context) to a validated identity (fail-closed). */
export function resolveIdentity(claim: IdentityClaim, ctx?: ResolveContext): ValidatedIdentity {
  return resolver.resolve(claim, ctx);
}

// --- re-export the frozen contract surface + building blocks ---
export {
  IdentityResolver,
  beginOperation,
  isOperator,
  isValidatedIdentity,
  // NOTE: `mint` is intentionally module-private (not exported anywhere) — only
  // the resolver can produce a ValidatedIdentity, so none can be forged.
} from "./resolver.js";
export type {
  IdentityResolverDeps,
  OperationContext,
  ResolveContext,
  RevalidationResult,
  ValidatedIdentity,
} from "./resolver.js";
export {
  AgentRegistry,
  assertStrongToken,
  generateAgentToken,
  hashToken,
  MIN_TOKEN_LENGTH,
} from "./registry.js";
export type { AgentRecord, AgentRegistryInit, TailscaleBinding } from "./registry.js";
export {
  IDENTITY_CONTRACT_VERSION,
  IdentityError,
  isTrustTier,
  staticTrustTierResolver,
  tierAllowedForKind,
  TRUST_TIERS,
  type AuthMethod,
  type IdentityClaim,
  type IdentityErrorKind,
  type IdentityKind,
  type TailscalePeer,
  type TrustTier,
  type TrustTierInput,
  type TrustTierResolver,
  type VerifiedPeer,
} from "./contract.js";
