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
import { access, mkdir } from "node:fs/promises";
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
  workingTreeDiff,
  isAncestor,
  isGitRepo,
  isWorktreeClean,
  listBranches,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  revParse,
  syncWorktreeToRef,
  updateRefCas,
  worktreeForBranch,
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

  /** Force a fresh preload on next access (invalidates the cache). Used when cross-process
   *  changes may have occurred since the last preload (Bubbles LOW-2). */
  invalidatePreloadCache(): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.initPromise;
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
    // Cross-process file lock: CLI + server share the same workspace store,
    // so the allocation check + create must be serialized across processes.
    return this.locks.withLock(ALLOC_LOCK, async () => {
      if (this.live.size >= this.max) {
        // Refresh the live Map from the persistent store before failing — another
        // process may have discarded workspaces since our last preload (Bubbles LOW-2).
        this.invalidatePreloadCache();
        await this.preload();
        if (this.live.size >= this.max) {
          throw new WorkspaceError("limit", `workspace limit reached (${this.max}); cannot allocate`);
        }
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
    const committed = await diffRange(handle.targetRepo, handle.baseRef, handle.scratchBranch);
    if (committed.trim().length > 0) return committed;
    // FALLBACK: RETAINED/failed work is UNCOMMITTED, so the committed base..scratch range is empty.
    // If the worktree dir still exists, compute the working-tree diff from it so `ikbi diff <id>`
    // shows the real changes left behind (never a misleading "no changes"). A cleaned/promoted
    // workspace has no worktree dir → returns the (empty) committed diff unchanged.
    if (await this.pathExists(handle.path)) {
      return workingTreeDiff(handle.path, handle.baseRef).catch(() => committed);
    }
    return committed;
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

        // The target branch is typically checked out in the repo's MAIN working tree. Moving its
        // ref (the CAS below) would leave HEAD ahead of that tree — a phantom revert in
        // `git status`. Resolve that worktree NOW: if it has uncommitted work, REFUSE (never
        // clobber it, never leave HEAD/tree silently disagreeing); if clean, we sync it after the CAS.
        const checkedOutPath = await worktreeForBranch(repo, handle.baseBranch);
        if (checkedOutPath !== undefined && !(await isWorktreeClean(checkedOutPath))) {
          return {
            promoted: false,
            workspaceId: handle.id,
            targetBranch: handle.baseBranch,
            beforeRef: targetHead,
            strategy: "noop",
            reason: `target branch "${handle.baseBranch}" is checked out at ${checkedOutPath} with uncommitted changes — refusing to promote (commit or stash there first, then retry)`,
          } satisfies PromoteResult;
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

        // The branch ref moved. If it is checked out (and clean — we refused otherwise above),
        // bring that working tree FORWARD to the new HEAD so HEAD and the tree agree and
        // `git status` is clean (no phantom revert). Never silently leaves them disagreeing.
        if (checkedOutPath !== undefined) {
          await syncWorktreeToRef(checkedOutPath, afterRef);
        }

        // Landed: record it durably FIRST (the registry is the landing proof), then receipt/event.
        const promoted: WorkspaceRecord = { ...promoting, state: "promoted", promotedTo: afterRef, updatedAt: this.now() };
        await this.store.put(handle.id, promoted);
        this.live.delete(handle.id);

        // Record the normal promote RECEIPT. The branch has already moved (the durable record above is
        // the landing proof), so a receipt failure here MUST NOT be swallowed: surface
        // PROMOTED_BUT_RECEIPT_FAILED and stamp the durable record so status/ls/undo can see the
        // degraded state and still recover from this record's before/after refs.
        const receiptStatus = await this.recordPromoteReceiptDurable(handle.identity, handle.targetRepo, handle.baseBranch, handle.id, targetHead, afterRef, strategy, approval.requestId);
        // The single terminal record carried through cleanup, so the stamp is never overwritten.
        let landedRecord: WorkspaceRecord = promoted;
        if (receiptStatus !== undefined) {
          landedRecord =
            receiptStatus === "failed"
              ? { ...promoted, receiptStatus, note: `PROMOTED_BUT_RECEIPT_FAILED: target moved ${targetHead}→${afterRef} but the promote receipt did not append — recover/undo via this durable record (\`ikbi undo ${afterRef}\`)` }
              : { ...promoted, receiptStatus };
          await this.store.put(handle.id, landedRecord).catch((e) =>
            this.log.error({ err: e instanceof Error ? e.message : String(e), workspaceId: handle.id }, "failed to stamp promote receiptStatus on the durable record"),
          );
          if (receiptStatus === "failed") {
            this.log.error({ event: "workspace_promote_receipt_failed", workspaceId: handle.id, beforeRef: targetHead, afterRef }, "PROMOTED_BUT_RECEIPT_FAILED: the target ref moved but the promote receipt append failed");
          }
        }

        const result: PromoteResult = { promoted: true, workspaceId: handle.id, targetBranch: handle.baseBranch, beforeRef: targetHead, afterRef, ...(mergeCommit !== undefined ? { mergeCommit } : {}), strategy, ...(receiptStatus !== undefined ? { receiptStatus } : {}) };
        this.events?.publish(
          WorkspaceEvents.promoted.create({ workspaceId: handle.id, targetBranch: handle.baseBranch, strategy, beforeRef: targetHead, afterRef }, { source: "workspace", attribution: { identity: handle.identity } }),
        );
        this.log.info({ event: "workspace_promoted", workspaceId: handle.id, strategy, beforeRef: targetHead, afterRef, targetBranch: handle.baseBranch, receiptStatus }, "workspace promoted");

        // SG-7: the source worktree DIRECTORY is no longer needed once promoted — free the disk
        // (best-effort; never undoes the landed promote). The scratch BRANCH is intentionally
        // KEPT so a post-build `ikbi diff <id>` can still compute base..scratch; `ikbi clean` /
        // reclaim removes the now-orphan branch later. The promoted record stays terminal — and
        // KEEPS its receiptStatus stamp (removeWorktreeDir re-persists THIS record, not the pre-stamp one).
        await this.removeWorktreeDir(landedRecord).catch((e) =>
          this.log.warn({ err: e instanceof Error ? e.message : String(e), workspaceId: handle.id }, "post-promote worktree cleanup failed (non-fatal)"),
        );
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

  // ---- retain (failed build: KEEP the worktree on disk for inspection) ----

  /**
   * Retain a workspace whose build FAILED instead of discarding it: mark the record terminal
   * (`failed`) and free its allocation slot (so the live bound is not held), but DELIBERATELY
   * KEEP the worktree directory + scratch branch on disk so the operator can inspect what was
   * built (e.g. a 13KB index.html the build wrote before timing out). Because the record is
   * terminal-`failed` with its path still present, a later `ikbi clean` (cleanOrphans) reclaims
   * the leftover directory — the manual/eventual cleanup the discard used to do eagerly.
   *
   * A `promoted` record is NEVER downgraded (its landed mutation stands). Idempotent for an
   * already-terminal record (no-op beyond a note refresh).
   */
  async retain(handle: WorkspaceHandle, reason: string): Promise<DiscardResult> {
    return this.locks.withLock(this.wsKey(handle.id), async () => {
      const rec = await this.store.get(handle.id);
      if (rec === undefined) {
        this.live.delete(handle.id);
        return { workspaceId: handle.id, removed: false };
      }
      if (rec.state === "promoted") {
        // Terminal-promoted: never downgrade; nothing to retain (the worktree dir is already freed).
        return { workspaceId: handle.id, removed: false };
      }
      // Mark failed (terminal) but KEEP the worktree dir + branch — no removeWorktree/deleteBranch.
      await this.store.put(handle.id, { ...rec, state: "failed", updatedAt: this.now(), note: `retained: ${reason}` });
      this.live.delete(handle.id);
      this.events?.publish(WorkspaceEvents.failed.create({ workspaceId: handle.id, reason }, { source: "workspace", attribution: { identity: handle.identity } }));
      this.log.info({ event: "workspace_retained", workspaceId: handle.id, reason, path: handle.path }, "workspace retained for inspection (worktree kept; reclaim later with `ikbi clean`)");
      return { workspaceId: handle.id, removed: false };
    });
  }

  /**
   * GRACEFUL SHUTDOWN (SIGINT): RETAIN every still-live ALLOCATED/ALLOCATING workspace — keep its
   * worktree, mark it terminal-`failed` (note `retained: …`), and free the slot — so an interrupt
   * never leaves an "allocated" record leaking the bound and silently abandoning on-disk work. The
   * retained records are then inspectable (`ikbi workspace ls` / `ikbi diff <id>`) and only removed
   * deliberately (`ikbi workspace discard` / `ikbi clean --force`). PROMOTING records are left for
   * crash-reconcile (a landed CAS must still reconcile to `promoted`). Best-effort; returns the count.
   */
  async retainAllLive(reason: string): Promise<number> {
    let retained = 0;
    for (const rec of [...this.live.values()]) {
      if (rec.state !== "allocating" && rec.state !== "allocated") continue;
      try {
        await this.retain(rec, reason);
        retained += 1;
      } catch {
        // best-effort — a shutdown must not throw.
      }
    }
    return retained;
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
    // Read-only access (CLI `diff`/`discard`-probe/`undo` recovery/build summary): degrade cleanly
    // under a live cross-process lock instead of crashing with a raw lock-acquisition error.
    return this.store.getTolerant(id);
  }

  /** All persisted workspace records (for `ikbi workspace ls`). Unreadable docs are skipped. */
  async list(): Promise<WorkspaceRecord[]> {
    const out: WorkspaceRecord[] = [];
    for (const id of await this.store.list()) {
      // Tolerant read so `ikbi workspace ls` (read-only) never crashes on a live registry lock.
      const rec = await this.store.getTolerant(id).catch(() => undefined);
      if (rec !== undefined) out.push(rec);
    }
    return out;
  }

  /** A record is RETAINED iff a failed build deliberately kept its worktree (the only copy of its
   *  uncommitted work) — `retain()` stamps the note `retained: …`. Reclaim-abandoned `failed`
   *  records carry `reclaimed: …` instead and are NOT retained (safe to clean without --force). */
  private isRetained(rec: WorkspaceRecord): boolean {
    return rec.state === "failed" && (rec.note ?? "").startsWith("retained:");
  }

  // ---- clean (SG-7): reclaim orphaned worktree DIRECTORIES of terminal records ----

  /**
   * Sweep TERMINAL workspaces (promoted / discarded / failed) whose worktree directory still
   * exists on disk and remove it (+ its scratch branch), marking the record `cleanedAt`. This
   * collects the leftover dirs under the workspace root that `promote`/`discard` didn't already
   * remove (e.g. a crash between landing and cleanup). Active workspaces are skipped (their
   * per-ws lock is held); a held lock is treated as "active" and left alone. Idempotent.
   *
   * RECLAIM WIRING: first runs `reclaim` per distinct repo (its only production caller) to
   * reconcile crash-leaked ACTIVE records and prune orphan worktrees/branches before the sweep.
   *
   * RETAINED-WORK SAFETY: a RETAINED failed build's worktree is the ONLY copy of its uncommitted
   * work. When `force` is false the sweep SKIPS those (reporting them in `skipped`/`skippedIds`)
   * so it can never destroy work the failure message told the operator to inspect. The CLI
   * `ikbi clean` passes `force:false`; `ikbi clean --force` opts into removing them. The core
   * default is also `force:false` so direct/programmatic callers are safe by default.
   */
  async cleanOrphans(opts: { force?: boolean; olderThanMs?: number } = {}): Promise<{ removed: number; checked: number; skipped: number; reclaimed: number; skippedIds: string[] }> {
    await this.preload();
    const force = opts.force ?? false;
    // Gap M16 — age-bounded sweep. When `olderThanMs` is set, only TERMINAL records last touched
    // before the cutoff are reclaimed (the safe retention-window auto-clean `ikbi doctor --fix`
    // runs without --force); a record still inside the window is left for an explicit `--force`.
    const ageCutoff = opts.olderThanMs !== undefined ? this.now() - opts.olderThanMs : undefined;

    // Wire reclaim (previously zero production callers): reconcile crash-leaked active records +
    // prune orphan worktrees/branches per distinct repo, BEFORE sweeping terminal dirs.
    let reclaimed = 0;
    const repos = new Set<string>();
    for (const id of await this.store.list()) {
      const rec = await this.store.get(id).catch(() => undefined);
      if (rec !== undefined) repos.add(rec.targetRepo);
    }
    for (const repo of repos) {
      try {
        reclaimed += (await this.reclaim(repo)).recordsReconciled;
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.message : String(err), repo }, "reclaim during clean failed (non-fatal)");
      }
    }

    let removed = 0;
    let checked = 0;
    let skipped = 0;
    const skippedIds: string[] = [];
    for (const id of await this.store.list()) {
      const rec = await this.store.get(id).catch(() => undefined);
      if (rec === undefined) continue;
      const terminal = rec.state === "promoted" || rec.state === "discarded" || rec.state === "failed";
      if (!terminal) continue;
      checked += 1;
      // Age-bounded sweep (M16): a terminal record still inside the retention window is left alone.
      if (ageCutoff !== undefined && rec.updatedAt > ageCutoff) {
        skipped += 1;
        skippedIds.push(id);
        continue;
      }
      if (!(await this.pathExists(rec.path))) continue; // dir already gone — nothing to reclaim
      // SAFETY: never destroy retained (the only copy of failed-build work) without --force.
      if (!force && this.isRetained(rec)) {
        skipped += 1;
        skippedIds.push(id);
        continue;
      }
      try {
        await this.locks.withLock(
          this.wsKey(id),
          async () => {
            await removeWorktree(rec.targetRepo, rec.path).catch(() => undefined);
            await pruneWorktrees(rec.targetRepo).catch(() => undefined);
            await deleteBranch(rec.targetRepo, rec.scratchBranch).catch(() => undefined);
            await this.store.put(id, { ...rec, cleanedAt: this.now() });
          },
          { timeoutMs: RECLAIM_WS_TIMEOUT_MS },
        );
        removed += 1;
      } catch (err) {
        if (err instanceof SubstrateError && err.kind === "lock_timeout") continue; // active — skip
        throw err;
      }
    }
    this.log.info({ event: "workspace_cleaned", removed, checked, skipped, reclaimed, force }, "reclaimed orphaned worktrees");
    return { removed, checked, skipped, reclaimed, skippedIds };
  }

  // ---- internals ----

  /** Remove the worktree DIRECTORY (+ admin entry) of a record, KEEPING the scratch branch. */
  private async removeWorktreeDir(rec: WorkspaceRecord): Promise<void> {
    await removeWorktree(rec.targetRepo, rec.path);
    await pruneWorktrees(rec.targetRepo);
    await this.store.put(rec.id, { ...rec, cleanedAt: this.now() });
  }

  /** True iff `p` exists on disk (a directory probe; never throws). */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

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
   * intended afterRef AND the recorded beforeRef is an ancestor of that ref, the
   * CAS landed => mark promoted (a landed mutation is always recorded); otherwise
   * it did not land => revert to allocated (promotable again).
   */
  private async reconcilePromoting(rec: WorkspaceRecord): Promise<void> {
    const intent = rec.promoteIntent;
    if (intent === undefined) {
      await this.store.put(rec.id, { ...rec, state: "allocated", updatedAt: this.now() });
      this.live.set(rec.id, { ...rec, state: "allocated" });
      return;
    }
    const targetHead = await revParse(rec.targetRepo, rec.baseBranch).catch(() => undefined);
    const landed = targetHead === intent.afterRef && (await isAncestor(rec.targetRepo, intent.beforeRef, intent.afterRef).catch(() => false));
    if (landed) {
      const checkedOutPath = await worktreeForBranch(rec.targetRepo, rec.baseBranch).catch(() => undefined);
      if (checkedOutPath !== undefined) await syncWorktreeToRef(checkedOutPath, intent.afterRef);
      const promoted: WorkspaceRecord = { ...rec, state: "promoted", promotedTo: intent.afterRef, updatedAt: this.now(), note: "reconciled: promote landed" };
      await this.store.put(rec.id, promoted);
      this.live.delete(rec.id);
      // A reconciled landing still records its receipt; a receipt failure here is the same
      // PROMOTED_BUT_RECEIPT_FAILED degraded state (the durable record stays the recovery source).
      const receiptStatus = await this.recordPromoteReceiptDurable(rec.identity, rec.targetRepo, rec.baseBranch, rec.id, intent.beforeRef, intent.afterRef, "merge", undefined);
      if (receiptStatus === "failed") {
        await this.store.put(rec.id, { ...promoted, receiptStatus, note: `${promoted.note}; PROMOTED_BUT_RECEIPT_FAILED on reconcile` }).catch(() => undefined);
      } else if (receiptStatus === "recorded") {
        await this.store.put(rec.id, { ...promoted, receiptStatus }).catch(() => undefined);
      }
      this.events?.publish(WorkspaceEvents.promoted.create({ workspaceId: rec.id, targetBranch: rec.baseBranch, strategy: "reconciled", beforeRef: intent.beforeRef, afterRef: intent.afterRef }, { source: "workspace", attribution: { identity: rec.identity } }));
      this.log.warn({ event: "workspace_promote_reconciled", workspaceId: rec.id, afterRef: intent.afterRef }, "reconciled a crashed promote that had landed");
    } else {
      const reverted: WorkspaceRecord = { ...rec, state: "allocated", updatedAt: this.now(), note: "reconciled: promote did not land" };
      await this.store.put(rec.id, reverted);
      this.live.set(rec.id, reverted);
      this.log.warn({ event: "workspace_promote_reverted", workspaceId: rec.id }, "reverted a crashed promote that did not land");
    }
  }

  /**
   * Append the durable promote RECEIPT. Returns "recorded" on success, "failed" if the append threw
   * (the caller surfaces PROMOTED_BUT_RECEIPT_FAILED and stamps the registry record), or `undefined`
   * when no receipt sink is wired (nothing to record — not a failure). NEVER throws (a receipt
   * failure must not unwind a landed promote) and NEVER silently swallows: a failure is returned.
   */
  private async recordPromoteReceiptDurable(
    identity: AgentIdentity,
    targetRepo: string,
    baseBranch: string,
    workspaceId: string,
    beforeRef: string,
    afterRef: string,
    strategy: string,
    requestId?: string,
  ): Promise<"recorded" | "failed" | undefined> {
    if (this.receipts === undefined) return undefined;
    try {
      await this.receipts.append(
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
          ...(requestId !== undefined ? { requestId } : {}),
        },
        identity,
      );
      return "recorded";
    } catch (err) {
      this.log.error({ err, workspaceId }, "failed to record promote receipt (PROMOTED_BUT_RECEIPT_FAILED)");
      return "failed";
    }
  }
}
