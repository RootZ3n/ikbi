/**
 * ikbi worker-model — CANDIDATE-GENERATION LEASES + FROZEN VERIFICATION SNAPSHOTS (Phase 13B).
 *
 * Phase 13 fenced timed-out promotions at the AUTHORITY (promotion refused a workspace whose latest mutating
 * generation timed out). Phase 13B makes the stronger invariant enforceable at the WRITE BOUNDARY and binds a
 * single immutable subject end-to-end:
 *
 *   > After a candidate GENERATION is frozen, no active or late operation can change the verification subject,
 *   > and promotion applies exactly the frozen subject identified by all evidence.
 *
 * The authority is GENERATION-scoped, not task-scoped. A distinct candidate GENERATION is opened for each round
 * of mutation (builder retry, peer attempt, fixer round, iterative/multi-step step, tournament/competitive
 * candidate, operator revision). Every candidate-mutating operation holds a `MutationLease` bound to its
 * generation; a write MUST verify the lease is still valid immediately before mutating. A lease is invalidated
 * when its generation times out, is revoked, is superseded by a newer generation on the same workspace, or is
 * frozen for verification. After invalidation a write is rejected — recording that a late write happened is not
 * enough. This module is PURE authority state; the orchestrator wires the write boundary + snapshot capture.
 */

/** The lifecycle of one candidate generation. Only an `active` generation may be mutated; only a `frozen` one is verified/promoted. */
export type GenerationLifecycle = "active" | "timed-out" | "revoked" | "superseded" | "frozen";

/** A stable, mutation-authoritative identity for ONE candidate generation (content may differ per generation). */
export interface CandidateGeneration {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly candidateId: string;
  readonly generationId: string;
  readonly workspaceId: string;
  readonly workspacePath?: string;
  /** The generation this one derived from (a fixer round / repaired candidate), when applicable. */
  readonly sourceGenerationId?: string;
  /** The tick this generation was opened (monotonic within the run) — orders supersession. */
  readonly openedAtTick: number;
}

/** A capability to mutate a specific candidate generation. Checked immediately before every authoritative write. */
export interface MutationLease {
  readonly leaseId: string;
  readonly generationId: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly issuedAtTick: number;
  readonly signal?: AbortSignal;
}

/** An immutable, content-addressed verification subject frozen from a generation once its leases are closed. */
export interface VerificationSnapshot {
  readonly snapshotId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly candidateId: string;
  readonly generationId: string;
  readonly sourceWorkspaceId: string;
  /** The canonical content digest (a git tree hash where git-backed, else a deterministic content digest). */
  readonly canonicalDigest: string;
  /** The git tree/commit identity, when git-backed. */
  readonly gitTree?: string;
  /** The authoritative-base identity the snapshot was verified against. */
  readonly baseIdentity?: string;
  readonly createdAtTick: number;
  readonly lifecycle: "frozen";
}

export interface FreezeEligibility {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * The per-run authority. One registry per `orchestrator.run` (keyed elsewhere by taskId). It tracks, per
 * workspace, the current generation + its lifecycle + active leases, orders supersession by tick, and gates
 * write + freeze eligibility. It is deterministic (an injectable tick source keeps tests hermetic).
 */
export class CandidateLeaseRegistry {
  private tick = 0;
  private seq = 0;
  private readonly generations = new Map<string, CandidateGeneration>(); // by generationId
  private readonly currentByWorkspace = new Map<string, string>(); // workspaceId → current generationId
  private readonly lifecycles = new Map<string, GenerationLifecycle>(); // generationId → lifecycle
  private readonly activeLeases = new Map<string, Set<string>>(); // generationId → set of leaseIds
  private readonly snapshots = new Map<string, VerificationSnapshot>(); // generationId → snapshot

  constructor(private readonly ids: { runId: string; taskId: string }) {}

  private nextTick(): number { return ++this.tick; }

  /** Open a NEW candidate generation for a workspace, superseding any prior ACTIVE generation there. */
  openGeneration(spec: { attemptId: string; candidateId: string; workspaceId: string; workspacePath?: string; sourceGenerationId?: string }): CandidateGeneration {
    const prior = this.currentByWorkspace.get(spec.workspaceId);
    if (prior !== undefined && this.lifecycles.get(prior) === "active") this.lifecycles.set(prior, "superseded");
    const generationId = `${this.ids.taskId}:${spec.workspaceId}:gen${++this.seq}`;
    const gen: CandidateGeneration = {
      runId: this.ids.runId, taskId: this.ids.taskId, attemptId: spec.attemptId, candidateId: spec.candidateId,
      generationId, workspaceId: spec.workspaceId, ...(spec.workspacePath !== undefined ? { workspacePath: spec.workspacePath } : {}),
      ...(spec.sourceGenerationId !== undefined ? { sourceGenerationId: spec.sourceGenerationId } : {}),
      openedAtTick: this.nextTick(),
    };
    this.generations.set(generationId, gen);
    this.lifecycles.set(generationId, "active");
    this.activeLeases.set(generationId, new Set());
    this.currentByWorkspace.set(spec.workspaceId, generationId);
    return gen;
  }

  generation(generationId: string): CandidateGeneration | undefined { return this.generations.get(generationId); }
  currentGeneration(workspaceId: string): CandidateGeneration | undefined {
    const id = this.currentByWorkspace.get(workspaceId);
    return id !== undefined ? this.generations.get(id) : undefined;
  }
  lifecycleOf(generationId: string): GenerationLifecycle | undefined { return this.lifecycles.get(generationId); }

  /** Issue a lease for a candidate-mutating operation on a generation. Throws if the generation is not active. */
  issueLease(generationId: string, operationId: string, signal?: AbortSignal): MutationLease {
    if (this.lifecycles.get(generationId) !== "active") throw new Error(`cannot issue a mutation lease for a non-active generation (${this.lifecycles.get(generationId) ?? "unknown"})`);
    const leaseId = `${generationId}:op${operationId}:${this.nextTick()}`;
    this.activeLeases.get(generationId)!.add(leaseId);
    return { leaseId, generationId, workspaceId: this.generations.get(generationId)!.workspaceId, operationId, issuedAtTick: this.tick, ...(signal !== undefined ? { signal } : {}) };
  }

  /** Close a lease (the operation finished cleanly). Idempotent. */
  closeLease(lease: MutationLease): void { this.activeLeases.get(lease.generationId)?.delete(lease.leaseId); }

  /** True when a lease is still authoritative: its generation is ACTIVE, the lease is open, and not aborted. */
  isLeaseValid(lease: MutationLease): boolean {
    if (this.lifecycles.get(lease.generationId) !== "active") return false;
    if (!(this.activeLeases.get(lease.generationId)?.has(lease.leaseId) ?? false)) return false;
    if (lease.signal?.aborted === true) return false;
    return true;
  }

  /** THE write boundary: a write may proceed ONLY when its lease is valid. A stale/revoked lease is rejected. */
  checkWrite(lease: MutationLease): FreezeEligibility {
    if (lease.signal?.aborted === true) return { ok: false, reason: "operation aborted" };
    const lc = this.lifecycles.get(lease.generationId);
    if (lc !== "active") return { ok: false, reason: `generation ${lc ?? "unknown"} — write rejected` };
    if (!(this.activeLeases.get(lease.generationId)?.has(lease.leaseId) ?? false)) return { ok: false, reason: "lease revoked/closed — write rejected" };
    return { ok: true };
  }

  /** Revoke a generation (timeout / cancellation / quarantine). All its leases become invalid; writes fail. */
  revokeGeneration(generationId: string, kind: "timed-out" | "revoked" = "revoked"): void {
    if (this.generations.has(generationId)) { this.lifecycles.set(generationId, kind); this.activeLeases.set(generationId, new Set()); }
  }
  /** Revoke the current generation of a workspace as timed-out (the Phase 13 mutation fence, generation-precise). */
  recordMutatingTimeout(workspaceId: string): void {
    const id = this.currentByWorkspace.get(workspaceId);
    if (id !== undefined) this.revokeGeneration(id, "timed-out");
  }

  /** Whether the CURRENT generation of a workspace is fenced (timed-out/revoked and not superseded by a fresh one). */
  isFenced(workspaceId: string): boolean {
    const id = this.currentByWorkspace.get(workspaceId);
    if (id === undefined) return false;
    const lc = this.lifecycles.get(id);
    return lc === "timed-out" || lc === "revoked";
  }

  /**
   * FREEZE ELIGIBILITY: a generation may be frozen into an immutable verification subject ONLY when no active
   * lease remains, it is not timed-out/revoked/superseded, and it is still the current generation of its
   * workspace. Any unknown/violated condition ⇒ not eligible (fail-closed).
   */
  canFreeze(generationId: string): FreezeEligibility {
    const gen = this.generations.get(generationId);
    if (gen === undefined) return { ok: false, reason: "unknown generation" };
    const lc = this.lifecycles.get(generationId);
    if (lc !== "active") return { ok: false, reason: `generation is ${lc ?? "unknown"}, not active` };
    if ((this.activeLeases.get(generationId)?.size ?? 0) > 0) return { ok: false, reason: "active mutation lease(s) remain" };
    if (this.currentByWorkspace.get(gen.workspaceId) !== generationId) return { ok: false, reason: "superseded by a newer generation" };
    return { ok: true };
  }

  /** Freeze a generation into an immutable snapshot. Only permitted when `canFreeze` is ok. */
  freeze(generationId: string, subject: { canonicalDigest: string; gitTree?: string; baseIdentity?: string }): VerificationSnapshot {
    const elig = this.canFreeze(generationId);
    if (!elig.ok) throw new Error(`cannot freeze generation: ${elig.reason}`);
    const gen = this.generations.get(generationId)!;
    const snapshot: VerificationSnapshot = {
      snapshotId: `${generationId}:snap`, runId: gen.runId, taskId: gen.taskId, attemptId: gen.attemptId,
      candidateId: gen.candidateId, generationId, sourceWorkspaceId: gen.workspaceId,
      canonicalDigest: subject.canonicalDigest, ...(subject.gitTree !== undefined ? { gitTree: subject.gitTree } : {}),
      ...(subject.baseIdentity !== undefined ? { baseIdentity: subject.baseIdentity } : {}),
      createdAtTick: this.nextTick(), lifecycle: "frozen",
    };
    this.lifecycles.set(generationId, "frozen");
    this.snapshots.set(generationId, snapshot);
    return snapshot;
  }

  snapshotOf(generationId: string): VerificationSnapshot | undefined { return this.snapshots.get(generationId); }
}
