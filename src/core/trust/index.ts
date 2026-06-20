/**
 * ikbi trust system — public surface (frozen core).
 *
 * The governance decision layer. It IS a `TrustTierResolver` (Phase-3 seam), so
 * the identity resolver can plug it in to return each agent's EARNED tier. It
 * persists its own durable per-agent state on the substrate (so earned trust
 * survives receipt pruning), applies DETERMINISTIC transition rules, and exposes
 * the tier→autonomy mapping the (later) gates + shadow-workspace consume.
 *
 *     // identity resolution gets the earned tier via the seam:
 *     // new IdentityResolver({ registry, logger, trustResolver: trust })
 *     await trust.preload();                              // warm the cache at startup
 *     const d = await trust.recordOutcome({ agentId, kind, defaultTrustTier, operation, status });
 *     const grant = autonomyForTier(d.tier);              // what the gates read
 *
 * SCOPE BOUNDARY: this builds the trust system + the tier→autonomy MAPPING (a
 * contract of named grants). It does NOT build the gates or the shadow-workspace —
 * those are later modules that READ this mapping.
 *
 * The default trust system is wired from `config` + the frozen substrate
 * DocumentStore, with the receipt read-seam injected for window-scoped signals.
 */

import { config } from "../config.js";
import { childLogger } from "../log.js";
import { receipts } from "../receipt/index.js";
import { createDocumentStore } from "../substrate/index.js";
import type { PersistedTrustState } from "./mac.js";
import { TrustSystem } from "./system.js";

const log = childLogger("trust");

function buildDefaultTrust(): TrustSystem {
  const tc = config.trust;
  if (tc.hmacKeyIsDefault) {
    log.warn({}, "IKBI_TRUST_HMAC_KEY is unset — using the insecure built-in trust-state MAC key; set it in production");
  }
  // Gap M15 — opt-in auto-promotion. When IKBI_TRUST_AUTO_PROMOTE is on, a worker earns a
  // tier after `autoPromoteAfter` consecutive PROMOTABLE successes (default 3) instead of the
  // conservative 20. This ONLY tightens the streak threshold of the EXISTING earned-promotion
  // machinery — the anti-farming guards (read-only verbs excluded, `minDistinctOps` distinct
  // operations) and the fail-closed floor are unchanged; trust is still EARNED, never assumed.
  // FAIL-CLOSED: default OFF, so the conservative streak stands unless the operator opts in.
  const effectivePromoteStreak = tc.autoPromote ? tc.autoPromoteAfter : tc.promoteStreak;
  if (tc.autoPromote) {
    log.info({ promoteStreak: effectivePromoteStreak }, "IKBI_TRUST_AUTO_PROMOTE is on — workers auto-promote after the configured success streak");
  }
  return new TrustSystem({
    store: createDocumentStore<PersistedTrustState>({ dir: tc.dir }),
    logger: log,
    promoteStreak: effectivePromoteStreak,
    demoteStreak: tc.demoteStreak,
    minDistinctOps: tc.promoteMinDistinctOps,
    hmacKey: tc.hmacKey,
    // FIX 6: 4-hour failure decay window. Stale failures don't accumulate across idle periods.
    failureWindowMs: 4 * 60 * 60 * 1000,
    // NOTE: the AUTHORITATIVE starting-tier registry is wired post-construction by
    // identity/index via `attachRegistry` — NOT here. identity/index already imports
    // this trust singleton (for the resolver's trustResolver); importing it back would
    // create a load-time cycle (identity accessing `trust` in its TDZ). One-way wiring
    // from identity avoids that. Until attached, a never-seen agent fails closed to the floor.
    // The Phase-5 read-seam for window-scoped recent signals (diagnostics).
    receiptReader: { summarizeAgent: (agentId) => receipts.summarizeAgent(agentId) },
    // A transition is receipt-worthy: record it as a governance receipt.
    sink: ({ agentId, kind, transition }) => {
      void receipts
        .append(
          {
            operation: "trust.transition",
            outcome: { status: "success", detail: `${transition.from} -> ${transition.to}` },
            metadata: { direction: transition.direction, reason: transition.reason, from: transition.from, to: transition.to },
          },
          { agentId, trustTier: transition.to, ...(kind === "operator" ? { functionalRole: "operator" } : {}) },
        )
        .catch((err: unknown) => log.error({ err, agentId }, "failed to record trust-transition receipt"));
    },
  });
}

/** The process-wide trust system (also the identity TrustTierResolver). */
export const trust: TrustSystem = buildDefaultTrust();

// --- re-export the frozen contract surface ---
export { TrustSystem } from "./system.js";
export type { TrustSystemDeps } from "./system.js";
export { applyOutcome, clearInjectionFlag, freshState } from "./rules.js";
export type { ApplyResult, RuleOptions } from "./rules.js";
export { canonicalize, computeMac, verifyUnwrap, wrap } from "./mac.js";
export type { PersistedTrustState } from "./mac.js";
export {
  TRUST_CONTRACT_VERSION,
  AGENT_CEILING,
  TRUST_FLOOR,
  MAX_TRANSITIONS,
  TrustError,
  asTier,
  autonomyForTier,
  clampTier,
  demoteTier,
  isPromotableOperation,
  promoteTier,
  tierRank,
  type AutonomyGrant,
  type GateLevel,
  type OutcomeStatus,
  type RecordOutcomeInput,
  type TransitionDirection,
  type TrustDecision,
  type TrustReceiptReader,
  type TrustSignalContext,
  type TrustSignalReceipt,
  type TrustState,
  type TrustTransition,
  type TrustTransitionSink,
} from "./contract.js";
