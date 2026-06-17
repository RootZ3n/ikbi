/**
 * ikbi memory-governor — PROPOSAL STORE.
 *
 * Backed by a substrate DocumentStore. Upserts by deterministic id.
 * Concurrency-safe, atomic writes, corrupt-quarantine.
 */

import { createDocumentStore } from "../../core/substrate/index.js";
import type { DocumentStore } from "../../core/substrate/store.js";
import {
  type MemoryGovernor,
  type MemoryProposal,
  type ProposalInput,
  type ProposalStatus,
} from "./contract.js";
import { makeProposalId } from "./guard.js";

/** Proposal ids permit ":" (the component separator) on top of the store's safe charset. */
const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Injectable dependencies (tests substitute store / clock / apply-fn). */
export interface MemoryGovernorDeps {
  readonly store?: DocumentStore<MemoryProposal>;
  readonly logger?: import("pino").Logger;
  readonly now?: () => number;
  /**
   * Apply an approved proposal to its target surface.
   * This is the ACTUAL write — only called on approval, never on proposal.
   * Returns void on success, throws on failure.
   */
  readonly apply?: (proposal: MemoryProposal) => Promise<void>;
}

/** The default apply function — a no-op. Real implementation wired at factory. */
async function defaultApply(_proposal: MemoryProposal): Promise<void> {
  // The real apply is wired by the factory with the actual brain/file writers.
  // Tests can substitute a recording fake.
}

/**
 * Build the memory-governor store. The default deps wire a DocumentStore
 * under the state root.
 */
export function createMemoryGovernor(deps: MemoryGovernorDeps = {}): MemoryGovernor {
  const store: DocumentStore<MemoryProposal> =
    deps.store ?? createDocumentStore<MemoryProposal>({
      dir: "memory-governor",
      idPattern: PROPOSAL_ID_PATTERN,
    });
  const now = deps.now ?? Date.now;
  const apply = deps.apply ?? defaultApply;

  async function propose(input: ProposalInput): Promise<MemoryProposal> {
    const id = makeProposalId(input.surface, input.target);
    const existing = await store.get(id);
    const t = now();

    const proposal: MemoryProposal = {
      id,
      surface: input.surface,
      target: input.target,
      content: input.content,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      agentId: input.agentId,
      status: "pending",
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
    };

    await store.put(id, proposal);
    return proposal;
  }

  async function approve(proposalId: string, reviewerId: string): Promise<MemoryProposal | undefined> {
    const existing = await store.get(proposalId);
    if (existing === undefined) return undefined;

    const t = now();
    const approved: MemoryProposal = {
      ...existing,
      status: "approved",
      updatedAt: t,
      reviewedAt: t,
      reviewedBy: reviewerId,
    };

    // Apply to the target surface
    await apply(approved);
    await store.put(proposalId, approved);
    return approved;
  }

  async function reject(proposalId: string, reviewerId: string): Promise<MemoryProposal | undefined> {
    const existing = await store.get(proposalId);
    if (existing === undefined) return undefined;

    const t = now();
    const rejected: MemoryProposal = {
      ...existing,
      status: "rejected",
      updatedAt: t,
      reviewedAt: t,
      reviewedBy: reviewerId,
    };

    await store.put(proposalId, rejected);
    return rejected;
  }

  async function rejectAll(reviewerId: string): Promise<number> {
    const all = await store.list();
    let count = 0;
    for (const id of all) {
      const existing = await store.get(id);
      if (existing !== undefined && existing.status === "pending") {
        const t = now();
        await store.put(id, {
          ...existing,
          status: "rejected",
          updatedAt: t,
          reviewedAt: t,
          reviewedBy: reviewerId,
        });
        count += 1;
      }
    }
    return count;
  }

  async function get(proposalId: string): Promise<MemoryProposal | undefined> {
    return store.get(proposalId);
  }

  async function list(status?: ProposalStatus): Promise<MemoryProposal[]> {
    const all = await store.list();
    const proposals: MemoryProposal[] = [];
    for (const id of all) {
      const p = await store.get(id);
      if (p !== undefined && (status === undefined || p.status === status)) {
        proposals.push(p);
      }
    }
    return proposals.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function stats(): Promise<{ pending: number; approved: number; rejected: number; total: number }> {
    const all = await store.list();
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    for (const id of all) {
      const p = await store.get(id);
      if (p !== undefined) {
        if (p.status === "pending") pending += 1;
        else if (p.status === "approved") approved += 1;
        else if (p.status === "rejected") rejected += 1;
      }
    }
    return { pending, approved, rejected, total: pending + approved + rejected };
  }

  return { propose, approve, reject, rejectAll, get, list, stats };
}
