/**
 * ikbi workspace primitive — the manager (crash-safe lifecycle).
 *
 * Built on the frozen substrate (DocumentStore registry + LockManager), identity
 * (attribution), events (lifecycle), receipts (promote reversibility).
 *
 * DURABILITY:
 *   - `preload()` reloads the registry at startup so the allocation bound counts
 *     persisted workspaces (survives restart) and crashed promotes reconcile.
 *   - allocate is RECORD-THEN-RESOURCE: an "allocating" intent record is written
 *     BEFORE the worktree, so a crash mid-allocate is reclaimable (no orphan).
 *   - promote writes a "promoting" intent (with the computed afterRef) BEFORE the
 *     CAS; on restart a landed CAS reconciles to "promoted" — a landed target
 *     mutation is always recorded and is never wrongly discarded.
 *
 * LOCKING (consistent order ALLOC -> ws-id -> target-branch, no reversal):
 *   - allocate: ALLOC then ws-id (for the new id).
 *   - promote: ws-id then target-branch (the CAS).
 *   - discard: ws-id.
 *   - reclaim: reclaim(repo) then ws-id (with a short timeout — skips active ones).
 *   Same-workspace lifecycle ops therefore serialize (no interleaved teardown).
 */

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Logger } from "pino";

import { defineEvent, type EventBusSurface } from "../events/contract.js";
import type { AgentIdentity } from "../provider/contract.js";
import type { ReceiptInput } from "../receipt/contract.js";
import type { LockManager } from "../substrate/lock.js";
import { SubstrateError } from "../substrate/contract.js";
import type { DocumentStore } from "../substrate/store.js";
import {
  type AllocateOptions,
  type DiscardResult,
  isValidWorkspaceId,
  type PromoteApproval,
  type PromoteResult,
  type ReclaimResult,
  SCRATCH_BRANCH_PREFIX,
  WORKSPACE_CONTRACT_VERSION,
  type WorkspaceHandle,
  type WorkspaceRecord,
  WorkspaceError,
} from "./contract.js";
import {
  addWorktree,
  commitAll,
  commitTree,
  computeMerge,
  currentBranch,
  deleteBranch,
  diffRange,
  isAncestor,
  isGitRepo,
  listBranches,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  revParse,
  updateRefCas,
} from "./git.js";

export const WorkspaceEvents = {
  allocated: defineEvent<{ workspaceId: string; targetRepo: string; baseBranch: string; path: string }>("workspace.allocated"),
  promoted: defineEvent<{ workspaceId: string; targetBranch: string; strategy: string; beforeRef: string; afterRef?: string }>("workspace.promoted"),
  discarded: defineEvent<{ workspaceId: string }>("workspace.discarded"),
  failed: defineEvent<{ workspaceId: string; reason: string }>("workspace.failed"),
  reclaimed: defineEvent<{ targetRepo: string; branchesDeleted: number; recordsReconciled: number }>("workspace.reclaimed"),
} as const;

export interface WorkspaceReceiptSink {
  append(input: ReceiptInput, identity: AgentIdentity): Promise<unknown>;
}

export interface WorkspaceManagerDeps {
  readonly root: string;
  readonly max: number;
  readonly locks: LockManager;
  readonly store: DocumentStore<WorkspaceRecord>;
  readonly logger: Logger;
  readonly events?: EventBusSurface;
  readonly receipts?: WorkspaceReceiptSink;
  readonly now?: () => number;
  readonly idGen?: () => string;
}

const ALLOC_LOCK = "workspace:alloc";
const RECLAIM_WS_TIMEOUT_MS = 200; // short: a held ws lock means the workspace is active -> skip

export class WorkspaceManager {
  private readonly root: string;
  private readonly max: number;
  private readonly locks: LockManager;
  private readonly store: DocumentStore<WorkspaceRecord>;
  private readonly log: Logger;
  private readonly events?: EventBusSurface;
  private readonly receipts?: WorkspaceReceiptSink;
  private readonly now: () => number;
  private readonly idGen: () => string;

  /** Active (allocating/allocated/promoting) workspaces — counts toward the bound. */
  private readonly live = new Map<string, WorkspaceRecord>();
  private initPromise?: Promise<number>;

  constructor(deps: WorkspaceManagerDeps) {
    this.root = deps.root;
    this.max = deps.max;
    this.locks = deps.locks;
    this.store = deps.store;
    this.log = deps.logger;
    if (deps.events) this.events = deps.events;
    if (deps.receipts) this.receipts = deps.receipts;
    this.now = deps.now ?? Date.now;
    this.idGen = deps.idGen ?? (() => randomBytes(8).toString("hex"));
  }

  // ---- startup: reload the durable registry (bound survives restart) ----

  /** Load persisted workspaces into the live set (counting the bound) + reconcile crashed promotes. */
  async preload(): Promise<number> {
    if (this.initPromise === undefined) this.initPromise = this.doPreload();
    return this.initPromise;
  }

  private async doPreload(): Promise<number> {
    let loaded = 0;
    for (const id of await this.store.list()) {
      const rec = await this.store.get(id).catch(() => undefined);
      if (rec === undefined) continue;
      if (rec.state === "promoting") {
        await this.reconcilePromoting(rec);
        const after = await this.store.get(id).catch(() => undefined);
        if (after && (after.state === "allocated" || after.state === "allocating")) {
          this.live.set(id, after);
          loaded += 1;
        }
      } else if (rec.state === "allocating" || rec.state === "allocated") {
        this.live.set(id, rec);
        loaded += 1;
      }
    }
    this.log.info({ event: "workspace_preloaded", loaded, bound: this.max }, "preloaded workspace registry");
    return loaded;
  }

  // ---- allocate (record-then-resource, bounded, serialized) ----

  async allocate(opts: AllocateOptions): Promise<WorkspaceHandle> {
    if (!(await isGitRepo(opts.targetRepo))) {
      throw new WorkspaceError("config", `target is not a git repository: ${opts.targetRepo}`);
    }
    await this.preload();
    return this.locks.withLock(ALLOC_LOCK, async () => {
      if (this.live.size >= this.max) {
        throw new WorkspaceError("limit", `workspace limit reached (${this.max}); cannot allocate`);
      }
      const baseBranch = opts.baseBranch ?? (await currentBranch(opts.targetRepo));
      const baseRef = await revParse(opts.targetRepo, baseBranch);
      const id = this.idGen();
      const path = this.resolveWorktreePath(id); // validates id + confines path
      const scratchBranch = SCRATCH_BRANCH_PREFIX + id;

      return this.locks.withLock(this.wsKey(id), async () => {
        const ts = this.now();
        const base: WorkspaceRecord = {
          id,
          targetRepo: opts.targetRepo,
          baseBranch,
          baseRef,
          scratchBranch,
          path,
          identity: opts.identity,
          state: "allocating",
          createdAt: ts,
          updatedAt: ts,
          ...(opts.label !== undefined ? { label: opts.label } : {}),
        };
        // 1. INTENT record before any resource (crash here => reclaimable, no orphan).
        await this.store.put(id, base);
        this.live.set(id, base);

        try {
          await mkdir(join(this.root, "wt"), { recursive: true });
          await addWorktree(opts.targetRepo, path, scratchBranch, baseBranch);
        } catch (err) {
          // Roll back the intent + any partial resource.
          await removeWorktree(opts.targetRepo, path).catch(() => undefined);
          await deleteBranch(opts.targetRepo, scratchBranch).catch(() => undefined);
          await this.store.put(id, { ...base, state: "failed", updatedAt: this.now(), note: "allocate failed" });
          this.live.delete(id);
          throw new WorkspaceError("git", `failed to create worktree for ${id}`, { cause: err });
        }

        // 2. Mark allocated.
        const allocated: WorkspaceRecord = { ...base, state: "allocated", updatedAt: this.now() };
        await this.store.put(id, allocated);
        this.live.set(id, allocated);

        this.events?.publish(
          WorkspaceEvents.allocated.create({ workspaceId: id, targetRepo: opts.targetRepo, baseBranch, path }, { source: "workspace", attribution: { identity: opts.identity } }),
        );
        this.log.info({ event: "workspace_allocated", workspaceId: id, targetRepo: opts.targetRepo, baseBranch, agentId: opts.identity.agentId }, "workspace allocated");
        return allocated;
      });
    });
  }

  async commit(handle: WorkspaceHandle, message: string): Promise<boolean> {
    return commitAll(handle.path, message);
  }

  async diff(handle: WorkspaceHandle): Promise<string> {
    return diffRange(handle.targetRepo, handle.baseRef, handle.scratchBranch);
  }

  // ---- promote (governed-closed, atomic CAS, crash-durable) ----

  async promote(handle: WorkspaceHandle, approval: PromoteApproval): Promise<PromoteResult> {
    if (!approval.evaluation.approved) {
      throw new WorkspaceError("not_approved", `promote refused: evaluation did not approve (workspace ${handle.id})`);
    }
    // Fail-closed: a promote requires an explicit allowing governance decision.
    if (approval.governance?.allow !== true) {
      throw new WorkspaceError("not_approved", `promote refused: explicit governance approval required (workspace ${handle.id})`);
    }

    const repo = handle.targetRepo;
    const ref = `refs/heads/${handle.baseBranch}`;
    // ws-id lock OUTER, target-branch lock INNER (consistent order).
    return this.locks.withLock(this.wsKey(handle.id), async () => {
      const rec = await this.store.get(handle.id);
      if (rec === undefined || rec.state !== "allocated") {
        throw new WorkspaceError("invalid_state", `workspace ${handle.id} is not in a promotable state`);
      }
      return this.locks.withLock(`workspace:branch:${repo}:${handle.baseBranch}`, async () => {
        const targetHead = await revParse(repo, handle.baseBranch);
        const scratchHead = await revParse(repo, handle.scratchBranch);

        if (scratchHead === targetHead) {
          return { promoted: false, workspaceId: handle.id, targetBranch: handle.baseBranch, beforeRef: targetHead, strategy: "noop", reason: "no changes to promote" } satisfies PromoteResult;
        }

        let afterRef: string;
        let mergeCommit: string | undefined;
        let strategy: "fast_forward" | "merge";
        if (await isAncestor(repo, targetHead, scratchHead)) {
          afterRef = scratchHead;
          strategy = "fast_forward";
        } else {
          const merge = await computeMerge(repo, targetHead, scratchHead);
          if (!merge.clean) {
            return { promoted: false, workspaceId: handle.id, targetBranch: handle.baseBranch, beforeRef: targetHead, strategy: "merge", conflicts: merge.conflicts, reason: "merge conflicts — governed resolution required" } satisfies PromoteResult;
          }
          mergeCommit = await commitTree(repo, merge.tree as string, [targetHead, scratchHead], approval.message ?? `ikbi: promote workspace ${handle.id}`);
          afterRef = mergeCommit;
          strategy = "merge";
        }

        // INTENT before the CAS (crash here => reconcile reads the target ref).
        const promoting: WorkspaceRecord = {
          ...rec,
          state: "promoting",
          updatedAt: this.now(),
          promoteIntent: { beforeRef: targetHead, afterRef, ...(mergeCommit !== undefined ? { mergeCommit } : {}) },
        };
        await this.store.put(handle.id, promoting);
        this.live.set(handle.id, promoting);

        await updateRefCas(repo, ref, afterRef, targetHead); // the single atomic target mutation

        // Landed: record it durably FIRST (the registry is the landing proof), then receipt/event.
        const promoted: WorkspaceRecord = { ...promoting, state: "promoted", promotedTo: afterRef, updatedAt: this.now() };
        await this.store.put(handle.id, promoted);
        this.live.delete(handle.id);

        const result: PromoteResult = { promoted: true, workspaceId: handle.id, targetBranch: handle.baseBranch, beforeRef: targetHead, afterRef, ...(mergeCommit !== undefined ? { mergeCommit } : {}), strategy };
        await this.recordPromoteReceipt(handle.identity, handle.targetRepo, handle.baseBranch, handle.id, targetHead, afterRef, strategy);
        this.events?.publish(
          WorkspaceEvents.promoted.create({ workspaceId: handle.id, targetBranch: handle.baseBranch, strategy, beforeRef: targetHead, afterRef }, { source: "workspace", attribution: { identity: handle.identity } }),
        );
        this.log.info({ event: "workspace_promoted", workspaceId: handle.id, strategy, beforeRef: targetHead, afterRef, targetBranch: handle.baseBranch }, "workspace promoted");
        return result;
      });
    });
  }

  // ---- discard (per-ws lock; terminal-promoted preserved) ----

  async discard(handle: WorkspaceHandle): Promise<DiscardResult> {
    return this.locks.withLock(this.wsKey(handle.id), async () => {
      await removeWorktree(handle.targetRepo, handle.path);
      await pruneWorktrees(handle.targetRepo);
      await deleteBranch(handle.targetRepo, handle.scratchBranch);

      const rec = await this.store.get(handle.id);
      if (rec?.state === "promoted") {
        // Terminal: preserve the promoted record (+promotedTo); only note the cleanup.
        await this.store.put(handle.id, { ...rec, cleanedAt: this.now(), updatedAt: this.now() });
      } else if (rec !== undefined) {
        await this.store.put(handle.id, { ...rec, state: "discarded", updatedAt: this.now() });
      }
      this.live.delete(handle.id);
      this.events?.publish(WorkspaceEvents.discarded.create({ workspaceId: handle.id }, { source: "workspace", attribution: { identity: handle.identity } }));
      this.log.info({ event: "workspace_discarded", workspaceId: handle.id, wasPromoted: rec?.state === "promoted" }, "workspace discarded");
      return { workspaceId: handle.id, removed: true };
    });
  }

  // ---- reclaim (respects the per-workspace lock; skips active) ----

  async reclaim(targetRepo: string): Promise<ReclaimResult> {
    return this.locks.withLock(`workspace:reclaim:${targetRepo}`, async () => {
      const before = (await listWorktrees(targetRepo)).length;
      await pruneWorktrees(targetRepo);
      const worktrees = await listWorktrees(targetRepo);
      const worktreesPruned = Math.max(0, before - worktrees.length);

      const liveBranches = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== undefined));
      const livePaths = new Set(worktrees.map((w) => w.path));

      let branchesDeleted = 0;
      for (const b of await listBranches(targetRepo, SCRATCH_BRANCH_PREFIX)) {
        if (!liveBranches.has(b)) {
          await deleteBranch(targetRepo, b);
          branchesDeleted += 1;
        }
      }

      let recordsReconciled = 0;
      for (const id of await this.store.list()) {
        const rec = await this.store.get(id).catch(() => undefined);
        if (rec === undefined || rec.targetRepo !== targetRepo) continue;
        if (rec.state !== "allocating" && rec.state !== "allocated" && rec.state !== "promoting") continue;
        try {
          await this.locks.withLock(
            this.wsKey(id),
            async () => {
              const did = await this.reclaimOne(rec, livePaths);
              if (did) recordsReconciled += 1;
            },
            { timeoutMs: RECLAIM_WS_TIMEOUT_MS },
          );
        } catch (err) {
          if (err instanceof SubstrateError && err.kind === "lock_timeout") {
            this.log.debug({ event: "workspace_reclaim_skip_active", workspaceId: id }, "skipped active/locked workspace during reclaim");
            continue;
          }
          throw err;
        }
      }

      const result: ReclaimResult = { worktreesPruned, branchesDeleted, recordsReconciled };
      this.events?.publish(WorkspaceEvents.reclaimed.create({ targetRepo, branchesDeleted, recordsReconciled }, { source: "workspace" }));
      this.log.info({ event: "workspace_reclaimed", targetRepo, ...result }, "reclaimed abandoned workspaces");
      return result;
    });
  }

  liveCount(): number {
    return this.live.size;
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    return this.store.get(id);
  }

  // ---- internals ----

  private wsKey(id: string): string {
    return `workspace:ws:${id}`;
  }

  private resolveWorktreePath(id: string): string {
    if (!isValidWorkspaceId(id)) {
      throw new WorkspaceError("config", `invalid workspace id (unsafe for path/branch): ${JSON.stringify(id)}`);
    }
    const wtDir = resolve(this.root, "wt");
    const full = resolve(wtDir, id);
    if (full !== wtDir && !full.startsWith(wtDir + sep)) {
      throw new WorkspaceError("config", `workspace id escapes the workspace root: ${JSON.stringify(id)}`);
    }
    return full;
  }

  /** Reconcile a single crash-abandoned record (caller holds the ws lock). Returns true if it acted. */
  private async reclaimOne(rec: WorkspaceRecord, livePaths: Set<string>): Promise<boolean> {
    if (rec.state === "promoting") {
      await this.reconcilePromoting(rec);
      return true;
    }
    if (rec.state === "allocating") {
      // Incomplete allocate: tear down any partial resource, mark failed.
      await removeWorktree(rec.targetRepo, rec.path).catch(() => undefined);
      await deleteBranch(rec.targetRepo, rec.scratchBranch).catch(() => undefined);
      await this.store.put(rec.id, { ...rec, state: "failed", updatedAt: this.now(), note: "reclaimed: incomplete allocate" });
      this.live.delete(rec.id);
      this.events?.publish(WorkspaceEvents.failed.create({ workspaceId: rec.id, reason: "incomplete_allocate" }, { source: "workspace", attribution: { identity: rec.identity } }));
      return true;
    }
    // allocated but worktree gone => crashed.
    if (!livePaths.has(rec.path)) {
      await deleteBranch(rec.targetRepo, rec.scratchBranch).catch(() => undefined);
      await this.store.put(rec.id, { ...rec, state: "failed", updatedAt: this.now(), note: "reclaimed: worktree missing" });
      this.live.delete(rec.id);
      this.events?.publish(WorkspaceEvents.failed.create({ workspaceId: rec.id, reason: "worktree_missing" }, { source: "workspace", attribution: { identity: rec.identity } }));
      return true;
    }
    return false;
  }

  /**
   * Reconcile a "promoting" record after a crash: if the target ref equals the
   * intended afterRef the CAS landed => mark promoted (a landed mutation is always
   * recorded); otherwise it did not land => revert to allocated (promotable again).
   */
  private async reconcilePromoting(rec: WorkspaceRecord): Promise<void> {
    const intent = rec.promoteIntent;
    if (intent === undefined) {
      await this.store.put(rec.id, { ...rec, state: "allocated", updatedAt: this.now() });
      this.live.set(rec.id, { ...rec, state: "allocated" });
      return;
    }
    const targetHead = await revParse(rec.targetRepo, rec.baseBranch).catch(() => undefined);
    if (targetHead === intent.afterRef) {
      const promoted: WorkspaceRecord = { ...rec, state: "promoted", promotedTo: intent.afterRef, updatedAt: this.now(), note: "reconciled: promote landed" };
      await this.store.put(rec.id, promoted);
      this.live.delete(rec.id);
      await this.recordPromoteReceipt(rec.identity, rec.targetRepo, rec.baseBranch, rec.id, intent.beforeRef, intent.afterRef, "merge");
      this.events?.publish(WorkspaceEvents.promoted.create({ workspaceId: rec.id, targetBranch: rec.baseBranch, strategy: "reconciled", beforeRef: intent.beforeRef, afterRef: intent.afterRef }, { source: "workspace", attribution: { identity: rec.identity } }));
      this.log.warn({ event: "workspace_promote_reconciled", workspaceId: rec.id, afterRef: intent.afterRef }, "reconciled a crashed promote that had landed");
    } else {
      const reverted: WorkspaceRecord = { ...rec, state: "allocated", updatedAt: this.now(), note: "reconciled: promote did not land" };
      await this.store.put(rec.id, reverted);
      this.live.set(rec.id, reverted);
      this.log.warn({ event: "workspace_promote_reverted", workspaceId: rec.id }, "reverted a crashed promote that did not land");
    }
  }

  private async recordPromoteReceipt(
    identity: AgentIdentity,
    targetRepo: string,
    baseBranch: string,
    workspaceId: string,
    beforeRef: string,
    afterRef: string,
    strategy: string,
  ): Promise<void> {
    if (this.receipts === undefined) return;
    await this.receipts
      .append(
        {
          operation: "workspace.promote",
          outcome: { status: "success", detail: strategy },
          changes: [
            {
              kind: "state",
              target: `${targetRepo}#${baseBranch}`,
              summary: `promote workspace ${workspaceId}`,
              before: { ref: beforeRef },
              after: { ref: afterRef },
              inverse: { operation: "git.update-ref", args: { ref: `refs/heads/${baseBranch}`, to: beforeRef } },
            },
          ],
          metadata: { workspaceId, strategy, contractVersion: WORKSPACE_CONTRACT_VERSION },
        },
        identity,
      )
      .catch((err: unknown) => this.log.error({ err, workspaceId }, "failed to record promote receipt"));
  }
}
