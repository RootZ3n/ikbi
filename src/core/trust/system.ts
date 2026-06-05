/**
 * ikbi trust system — the durable, deterministic, FAIL-CLOSED trust engine.
 *
 * Implements the Phase-3 `TrustTierResolver` seam (SYNCHRONOUS `resolve`), backed
 * by MAC-protected per-agent durable state on the substrate `DocumentStore` and an
 * in-memory cache the sync resolver reads.
 *
 * FAIL-CLOSED (a security gradient must never resolve HIGHER than earned):
 *   - Cold cache miss => resolve to the FLOOR (not the optimistic registry
 *     default) and load durable state in the background. Only an agent CONFIRMED
 *     to have no durable state gets its registry default. This closes the
 *     escalation window for a previously-demoted agent on a cold cache.
 *   - A corrupt/unreadable state read is a SECURITY EVENT => fail closed to the
 *     floor, never swallowed to "looks like a new agent".
 *   - A trust doc whose integrity MAC does not verify (hand-edited/forged) is
 *     REJECTED => fail closed to the floor (an agent with a write primitive cannot
 *     self-promote by editing the file).
 *
 * STARTUP: call `preload()` once before serving so the cache is warm.
 *
 * Signal intake is NARROW + VALIDATED: `recordFromReceipt` derives the signal from
 * a completed, attributed operation receipt — not free-form caller input.
 */

import { createHash } from "node:crypto";
import type { Logger } from "pino";

import type { TrustTier, TrustTierInput, TrustTierResolver } from "../identity/contract.js";
import { isOperator, isValidatedIdentity } from "../identity/resolver.js";
import type { ValidatedIdentity } from "../identity/resolver.js";
import type { DocumentStore } from "../substrate/store.js";
import {
  AGENT_CEILING,
  asTier,
  type AutonomyGrant,
  autonomyForTier,
  clampTier,
  MAX_TRANSITIONS,
  type OutcomeStatus,
  type RecordOutcomeInput,
  tierRank,
  TRUST_FLOOR,
  type TrustDecision,
  TrustError,
  type TrustReceiptReader,
  type TrustSignalContext,
  type TrustSignalReceipt,
  type TrustState,
  type TrustTransition,
  type TrustTransitionSink,
} from "./contract.js";
import { type PersistedTrustState, verifyUnwrap, wrap } from "./mac.js";
import { applyOutcome, clearInjectionFlag, freshState } from "./rules.js";

const VALID_STATUS: ReadonlySet<string> = new Set(["success", "failure", "partial", "rejected"]);

export interface TrustSystemDeps {
  readonly store: DocumentStore<PersistedTrustState>;
  readonly logger: Logger;
  readonly promoteStreak: number;
  readonly demoteStreak: number;
  readonly minDistinctOps: number;
  /** MAC key for trust-state integrity (kept separate from the trust dir). */
  readonly hmacKey: string;
  readonly sink?: TrustTransitionSink;
  readonly receiptReader?: TrustReceiptReader;
  readonly now?: () => number;
}

function docKey(agentId: string): string {
  return createHash("sha256").update(agentId, "utf8").digest("hex");
}

export class TrustSystem implements TrustTierResolver {
  private readonly store: DocumentStore<PersistedTrustState>;
  private readonly log: Logger;
  private readonly promoteStreak: number;
  private readonly demoteStreak: number;
  private readonly minDistinctOps: number;
  private readonly key: string;
  private readonly sink?: TrustTransitionSink;
  private readonly receiptReader?: TrustReceiptReader;
  private readonly now: () => number;

  private readonly cache = new Map<string, TrustState>();
  /** Agents whose durable state has been checked (found or confirmed-absent). */
  private readonly checked = new Set<string>();
  /** Agents whose state failed to read/verify — resolve to the floor (security event). */
  private readonly failedClosed = new Set<string>();
  private readonly loading = new Set<string>();

  constructor(deps: TrustSystemDeps) {
    this.store = deps.store;
    this.log = deps.logger;
    this.promoteStreak = deps.promoteStreak;
    this.demoteStreak = deps.demoteStreak;
    this.minDistinctOps = deps.minDistinctOps;
    this.key = deps.hmacKey;
    if (deps.sink) this.sink = deps.sink;
    if (deps.receiptReader) this.receiptReader = deps.receiptReader;
    this.now = deps.now ?? Date.now;
  }

  // ---- Phase-3 TrustTierResolver seam (synchronous, fail-closed) ----

  resolve(input: TrustTierInput): string {
    if (input.kind === "operator") return "operator"; // apex — trust does not manage the operator

    // A state read that failed/forged => fail closed to the floor.
    if (this.failedClosed.has(input.agentId)) {
      this.log.warn({ event: "trust_resolve_failclosed", agentId: input.agentId, tier: TRUST_FLOOR }, "resolving to floor (state unreadable/forged)");
      return TRUST_FLOOR;
    }

    const cached = this.cache.get(input.agentId);
    if (cached !== undefined) {
      return clampTier(cached.tier, TRUST_FLOOR, AGENT_CEILING);
    }

    if (this.checked.has(input.agentId)) {
      // Confirmed: no durable state => a genuinely-new agent gets its registry default.
      return clampTier(asTier(input.defaultTrustTier, "probation"), TRUST_FLOOR, AGENT_CEILING);
    }

    // Not yet loaded: fail closed to the FLOOR (never the optimistic default), load in background.
    this.backgroundLoad(input.agentId);
    this.log.debug({ event: "trust_resolve_cold", agentId: input.agentId, tier: TRUST_FLOOR }, "cold cache; resolving to floor pending load");
    return TRUST_FLOOR;
  }

  /** Load every persisted agent state into the cache. Call once at startup. */
  async preload(): Promise<{ loaded: number; rejected: number }> {
    let loaded = 0;
    let rejected = 0;
    const ids = await this.store.list();
    for (const id of ids) {
      let persisted: PersistedTrustState | undefined;
      try {
        persisted = await this.store.get(id);
      } catch {
        rejected += 1; // corrupt/unreadable doc — surfaces (fail-closed) when its agent resolves
        continue;
      }
      const state = verifyUnwrap(this.key, persisted);
      if (state === undefined) {
        rejected += 1;
        continue;
      }
      this.cache.set(state.agentId, state);
      this.checked.add(state.agentId);
      loaded += 1;
    }
    this.log.info({ event: "trust_preloaded", loaded, rejected }, "preloaded trust state");
    return { loaded, rejected };
  }

  // ---- VALIDATED signal intake ----

  /**
   * Record a behavior signal derived from a completed, attributed operation
   * RECEIPT (the sanctioned, validated source). Validates the receipt shape, then
   * applies the deterministic rules. This is how trust signals enter the system.
   */
  async recordFromReceipt(receipt: TrustSignalReceipt, ctx: TrustSignalContext): Promise<TrustDecision> {
    const agentId = receipt.identity?.agentId;
    const operation = receipt.operation;
    const status = receipt.outcome?.status;
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new TrustError("invalid_agent", "receipt has no attributed agentId");
    }
    if (typeof operation !== "string" || operation.length === 0 || typeof status !== "string" || !VALID_STATUS.has(status)) {
      throw new TrustError("state", "receipt has an invalid operation/status");
    }
    const injection = receipt.metadata?.injectionDetected === true || receipt.metadata?.injection === true;
    return this.recordOutcome({
      agentId,
      kind: ctx.kind,
      defaultTrustTier: ctx.defaultTrustTier,
      operation,
      status: status as OutcomeStatus,
      ...(injection ? { signals: { injection: true } } : {}),
    });
  }

  /**
   * Engine-internal: record a validated outcome and apply transitions. Prefer
   * `recordFromReceipt` (the validated source). Persists MAC-protected state.
   */
  async recordOutcome(input: RecordOutcomeInput): Promise<TrustDecision> {
    if (typeof input.agentId !== "string" || input.agentId.length === 0) {
      throw new TrustError("invalid_agent", "recordOutcome requires a non-empty agentId");
    }
    if (!VALID_STATUS.has(input.status) || typeof input.operation !== "string" || input.operation.length === 0) {
      throw new TrustError("state", "recordOutcome requires a valid operation + status");
    }
    if (input.kind === "operator") {
      return { agentId: input.agentId, tier: "operator", previousTier: "operator", autonomy: autonomyForTier("operator") };
    }

    const opts = { promoteStreak: this.promoteStreak, demoteStreak: this.demoteStreak, minDistinctOps: this.minDistinctOps, now: this.now() };
    let previousTier: TrustTier = clampTier(asTier(input.defaultTrustTier, "probation"), TRUST_FLOOR, AGENT_CEILING);
    let transition: TrustTransition | undefined;
    let newState: TrustState | undefined;

    let persisted: PersistedTrustState;
    try {
      persisted = await this.store.update(docKey(input.agentId), (curPersisted) => {
        const cur = curPersisted === undefined ? undefined : verifyUnwrap(this.key, curPersisted);
        if (curPersisted !== undefined && cur === undefined) {
          // The existing doc failed integrity — refuse to build trust on a forged base.
          throw new TrustError("state", `trust state for "${input.agentId}" failed integrity verification`);
        }
        previousTier = cur?.tier ?? previousTier;
        const result = applyOutcome(cur, input, opts);
        transition = result.transition;
        newState = result.state;
        return wrap(this.key, result.state);
      });
    } catch (err) {
      this.failedClosed.add(input.agentId);
      this.log.error({ event: "trust_state_rejected", agentId: input.agentId, err }, "trust state failed integrity (fail-closed)");
      throw err;
    }

    const state = verifyUnwrap(this.key, persisted) ?? newState;
    if (state !== undefined) {
      this.cache.set(input.agentId, state);
      this.checked.add(input.agentId);
      this.failedClosed.delete(input.agentId);
    }
    const finalState = state ?? newState;
    const tier = finalState?.tier ?? TRUST_FLOOR;

    if (transition !== undefined) {
      this.log.info(
        {
          event: "trust_transition",
          agentId: input.agentId,
          kind: input.kind,
          direction: transition.direction,
          from: transition.from,
          to: transition.to,
          reason: transition.reason,
          injectionFlagged: finalState?.injectionFlagged ?? false,
        },
        `trust ${transition.direction}: ${transition.from} -> ${transition.to} (${transition.reason})`,
      );
      this.sink?.({ agentId: input.agentId, kind: input.kind, transition });
    }

    return {
      agentId: input.agentId,
      tier,
      previousTier,
      ...(transition !== undefined ? { transition } : {}),
      autonomy: autonomyForTier(tier),
    };
  }

  /** OPERATOR action: clear an agent's non-recoverable injection flag (operator reset). */
  async operatorReset(input: { agentId: string; kind: "agent"; defaultTrustTier: string }): Promise<TrustState> {
    const now = this.now();
    let newState: TrustState | undefined;
    const persisted = await this.store.update(docKey(input.agentId), (cur) => {
      const verified = cur === undefined ? undefined : verifyUnwrap(this.key, cur);
      const base = verified ?? freshState(input, now);
      newState = clearInjectionFlag(base, now);
      return wrap(this.key, newState);
    });
    const state = verifyUnwrap(this.key, persisted) ?? newState!;
    this.cache.set(input.agentId, state);
    this.checked.add(input.agentId);
    this.failedClosed.delete(input.agentId);
    this.log.info({ event: "trust_operator_reset", agentId: input.agentId, tier: state.tier }, "operator cleared injection flag");
    return state;
  }

  /**
   * OPERATOR action: GRANT a worker an initial trust tier — the cold-start on-ramp.
   *
   * A fresh worker resolves to the untrusted FLOOR on a cold cache (deliberate
   * fail-closed), and untrusted/probation require approval — so a never-seen worker
   * is rejected on its first invocation with no path to work. This is a DELIBERATE,
   * AUTHORIZED, durable override of that cold floor: the operator (the apex) sets a
   * worker's tier directly, written MAC-protected through the existing trust store
   * and logged as a transition (granted, NOT earned). It bypasses the earned-rules
   * exactly as `operatorReset` bypasses them — that is the point of a grant.
   *
   * GATED: only an operator-tier identity may grant (a non-operator is rejected —
   * an agent cannot grant itself trust). CEILING-CAPPED: the granted tier must be
   * <= the agent ceiling (`trusted`) — an operator CANNOT grant the operator apex
   * (trust does not manage the operator). The floor itself is unchanged: trust is
   * still GRANTED by an authorized operator, never claimed by config or auto-assigned.
   */
  async grantTier(
    input: { agentId: string; kind: "agent"; tier: TrustTier; defaultTrustTier: string },
    granter: ValidatedIdentity,
  ): Promise<TrustState> {
    // PROVENANCE before AUTHORIZATION: verify the granter is a GENUINELY-MINTED
    // ValidatedIdentity (the unforgeable private-brand + WeakSet check) BEFORE asking
    // whether it is operator-tier. A forged/cast plain object `{ kind: "operator" }`
    // fails this and is rejected before `isOperator` is ever consulted — closing the
    // forged-operator escalation (trusting a value's CLAIM over its PROVENANCE).
    if (!isValidatedIdentity(granter)) {
      throw new TrustError("config", "grant requires a validated identity");
    }
    if (!isOperator(granter)) {
      throw new TrustError("config", "only an operator-tier identity may grant trust");
    }
    // Ceiling cap: lower rank = MORE trust. A tier above the agent ceiling (i.e.
    // `operator`, rank 0) is rejected — the operator apex is not grantable.
    if (tierRank(input.tier) < tierRank(AGENT_CEILING)) {
      throw new TrustError("config", `cannot grant tier "${input.tier}" — above the agent ceiling "${AGENT_CEILING}"`);
    }
    const now = this.now();
    let newState: TrustState | undefined;
    let transition: TrustTransition | undefined;
    const persisted = await this.store.update(docKey(input.agentId), (cur) => {
      const verified = cur === undefined ? undefined : verifyUnwrap(this.key, cur);
      if (cur !== undefined && verified === undefined) {
        // Refuse to grant on top of a forged/corrupt base (fail-closed).
        throw new TrustError("state", `trust state for "${input.agentId}" failed integrity verification`);
      }
      const base = verified ?? freshState(input, now);
      // A never-seen worker is effectively at the cold FLOOR before the grant — that
      // is the honest `from` for the audit trail (the grant moves it off the floor).
      const from = verified?.tier ?? TRUST_FLOOR;
      const to = clampTier(input.tier, TRUST_FLOOR, AGENT_CEILING);
      if (to !== from) {
        transition = { at: now, direction: tierRank(to) < tierRank(from) ? "promote" : "demote", from, to, reason: "operator_grant" };
      }
      const next: TrustState = {
        ...base,
        tier: to,
        ...(transition !== undefined
          ? { transitions: [...base.transitions, transition].slice(-MAX_TRANSITIONS), lastTransition: transition }
          : {}),
        updatedAt: now,
      };
      newState = next;
      return wrap(this.key, next);
    });
    const state = verifyUnwrap(this.key, persisted) ?? newState!;
    // Live in-process AND persisted for the next run (preload reloads it).
    this.cache.set(input.agentId, state);
    this.checked.add(input.agentId);
    this.failedClosed.delete(input.agentId);
    this.log.info(
      { event: "trust_operator_grant", agentId: input.agentId, granter: granter.identity.agentId, tier: state.tier },
      `operator granted ${input.agentId} -> ${state.tier}`,
    );
    if (transition !== undefined) this.sink?.({ agentId: input.agentId, kind: input.kind, transition });
    return state;
  }

  // ---- read surface ----

  getState(agentId: string): TrustState | undefined {
    return this.cache.get(agentId);
  }

  async loadState(agentId: string): Promise<TrustState | undefined> {
    let persisted: PersistedTrustState | undefined;
    try {
      persisted = await this.store.get(docKey(agentId));
    } catch (err) {
      this.failedClosed.add(agentId);
      this.log.error({ event: "trust_state_unreadable", agentId, err }, "trust state unreadable (fail-closed to floor)");
      return undefined;
    }
    if (persisted === undefined) {
      this.checked.add(agentId);
      return undefined;
    }
    const state = verifyUnwrap(this.key, persisted);
    if (state === undefined) {
      this.failedClosed.add(agentId);
      this.log.error({ event: "trust_state_rejected", agentId }, "trust state failed integrity (forged/corrupt); fail-closed to floor");
      return undefined;
    }
    this.cache.set(agentId, state);
    this.checked.add(agentId);
    this.failedClosed.delete(agentId);
    return state;
  }

  autonomyFor(input: TrustTierInput): AutonomyGrant {
    return autonomyForTier(asTier(this.resolve(input), TRUST_FLOOR));
  }

  async recentBehavior(agentId: string): Promise<{ total: number; byStatus: Readonly<Record<string, number>> } | null> {
    if (this.receiptReader === undefined) return null;
    return this.receiptReader.summarizeAgent(agentId);
  }

  private backgroundLoad(agentId: string): void {
    if (this.loading.has(agentId) || this.cache.has(agentId) || this.checked.has(agentId)) return;
    this.loading.add(agentId);
    void this.loadState(agentId).finally(() => this.loading.delete(agentId));
  }
}
