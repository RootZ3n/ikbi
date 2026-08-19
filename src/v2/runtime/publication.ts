/**
 * ADAPTER — the clean-ref CAS publication target, built on v1's git primitives.
 *
 * This is the ONLY thing in v2 that moves a target ref. It reuses the donor CAS primitive
 * (`updateRefCas`) and the donor worktree-sync (`syncWorktreeToRef`) rather than reinventing
 * them; it does NOT go through `WorkspaceManager.promote`, which auto-merges (forbidden here)
 * and requires a governed approval this authority does not use.
 *
 * The publish is exact-tree-only and crash-durable at the CAS:
 *   commit(tree=candidateTreeId, parent=authorized base) → verify the built tree == candidate
 *   tree BEFORE any ref move → durable INTENT file → updateRefCas(beforeRef→commit) → sync a
 *   clean checked-out worktree → durable LANDED file.
 *
 * A CAS that loses the race throws (git `update-ref` old-sha guard); we map that to a
 * `cas_conflict` outcome — no force, no retry against a new head. A worktree sync failure
 * AFTER the ref moved is a DEGRADED SUCCESS (`landed_desynced`), never an ordinary failure.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { revParse, updateRefCas, commitTree, worktreeForBranch, isWorktreeClean, syncWorktreeToRef } from "../../core/workspace/git.js";
import type { PromotionTarget, PromotionTargetRef, PublicationOutcome } from "../core/promotion.js";

/** Where crash-durable promotion intent/landed markers are written, for reconciliation + audit. */
export interface PublicationJournal {
  /** Write the pre-CAS intent (beforeRef, intended afterRef, candidate/disposition identity). */
  intent(record: Readonly<Record<string, string>>): void;
  /** Write the post-CAS landed marker (the landing proof). */
  landed(record: Readonly<Record<string, string>>): void;
}

/** A no-op journal — used by tests that do not assert durability. */
export const NO_JOURNAL: PublicationJournal = { intent: () => {}, landed: () => {} };

/**
 * A filesystem journal under a directory. Each publication writes `promotion-intent.json`
 * before the CAS and `promotion-landed.json` after — enough for a future recovery to
 * reconcile a crash (the git ref state + these markers say whether the CAS landed).
 */
export function createFilePublicationJournal(dir: string): PublicationJournal {
  const write = (name: string, record: Readonly<Record<string, string>>) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2), "utf8");
    } catch {
      // Best-effort durability: a journal write failure must not, by itself, prevent a
      // publication. The git ref state remains the ultimate source of truth.
    }
  };
  return {
    intent: (record) => write("promotion-intent.json", record),
    landed: (record) => write("promotion-landed.json", record),
  };
}

/**
 * THE clean-ref CAS publication target. Reads git facts and performs the one atomic publish.
 * `journal` records crash-durable intent; it defaults to a no-op.
 */
export function createCasPublicationTarget(journal: PublicationJournal = NO_JOURNAL): PromotionTarget {
  const branchRef = (baseBranch: string) => `refs/heads/${baseBranch}`;

  return {
    async liveHead(target: PromotionTargetRef): Promise<string | undefined> {
      try {
        return await revParse(target.repositoryPath, target.baseBranch);
      } catch {
        return undefined;
      }
    },

    async treeOfCommit(input: { repositoryPath: string; commit: string }): Promise<string | undefined> {
      try {
        return await revParse(input.repositoryPath, `${input.commit}^{tree}`);
      } catch {
        return undefined;
      }
    },

    async targetCheckout(target: PromotionTargetRef): Promise<{ checkedOutPath?: string; clean: boolean }> {
      const checkedOutPath = await worktreeForBranch(target.repositoryPath, target.baseBranch);
      if (checkedOutPath === undefined) return { clean: true };
      const clean = await isWorktreeClean(checkedOutPath);
      return { checkedOutPath, clean };
    },

    async publish(input): Promise<PublicationOutcome> {
      const { target, expectedHead, candidateTreeId, message } = input;
      const repo = target.repositoryPath;
      const ref = branchRef(target.baseBranch);

      // Build the publication commit: the EXACT candidate tree, parented on the authorized base.
      let commit: string;
      let builtTree: string;
      try {
        commit = await commitTree(repo, candidateTreeId, [target.baseCommit], message);
        builtTree = await revParse(repo, `${commit}^{tree}`);
      } catch (err) {
        return { kind: "infrastructure_failure", detail: `could not build the publication commit: ${err instanceof Error ? err.message : String(err)}` };
      }
      // Exact-tree guard BEFORE any ref move — nothing has landed yet.
      if (builtTree !== candidateTreeId) {
        return { kind: "tree_mismatch", builtTree };
      }

      // A clean checked-out target worktree is brought forward AFTER the CAS. Resolve its path now.
      let checkedOutPath: string | undefined;
      try {
        checkedOutPath = await worktreeForBranch(repo, target.baseBranch);
      } catch {
        checkedOutPath = undefined;
      }

      // Durable INTENT before the irreversible CAS — a crash here is reconcilable from the ref.
      journal.intent({ beforeRef: expectedHead, afterRef: commit, publishedTree: candidateTreeId, targetBranch: target.baseBranch });

      // THE single atomic target mutation. Its old-sha guard fails the CAS if the ref moved.
      try {
        await updateRefCas(repo, ref, commit, expectedHead);
      } catch {
        // Determine whether we lost a race (ref moved) vs a hard git error.
        let observedHead = expectedHead;
        try {
          observedHead = await revParse(repo, target.baseBranch);
        } catch {
          /* leave observedHead as expected */
        }
        if (observedHead !== expectedHead) return { kind: "cas_conflict", observedHead };
        return { kind: "infrastructure_failure", detail: "update-ref CAS failed although the ref appears unchanged" };
      }

      // The ref moved. From here, NOTHING may be reported as an ordinary failure — the
      // repository changed. A worktree sync failure is a DEGRADED SUCCESS.
      journal.landed({ beforeRef: expectedHead, afterRef: commit, publishedTree: candidateTreeId, targetBranch: target.baseBranch });

      let worktreeSynced = false;
      let stashed = false;
      if (checkedOutPath !== undefined) {
        try {
          const sync = await syncWorktreeToRef(checkedOutPath, commit);
          worktreeSynced = true;
          stashed = sync.stashed;
        } catch (err) {
          return { kind: "landed_desynced", beforeRef: expectedHead, afterCommit: commit, publishedTree: candidateTreeId, detail: `the target ref moved ${expectedHead}→${commit} but the checked-out worktree at ${checkedOutPath} could not be synced: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      return { kind: "landed", beforeRef: expectedHead, afterCommit: commit, publishedTree: candidateTreeId, worktreeSynced, stashed };
    },
  };
}
