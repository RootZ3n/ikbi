/**
 * ADAPTER — the clean-ref CAS publication target, built on v1's git primitives.
 *
 * This is the ONLY thing in v2 that moves a target ref. It reuses the donor CAS primitive
 * (`updateRefCas`) and the donor worktree-sync (`syncWorktreeToRef`) rather than reinventing
 * them; it does NOT go through `WorkspaceManager.promote`, which auto-merges (forbidden here)
 * and requires a governed approval this authority does not use.
 *
 * The publish is exact-tree-only. Its authoritative landing proof is the GIT REF/TREE, NOT a
 * journal: the journal is BEST-EFFORT (V2-016) and its write status is REPORTED, never disguised
 * as crash durability. Sequence:
 *   commit(tree=candidateTreeId, parent=authorized base) → verify the built tree == candidate
 *   tree BEFORE any ref move → best-effort INTENT marker → updateRefCas(beforeRef→commit) →
 *   best-effort LANDED marker → sync a clean checked-out worktree → FRESH post-CAS reprobe of the
 *   authoritative ref/tree.
 *
 * A CAS that loses the race throws (git `update-ref` old-sha guard); we map that to a
 * `cas_conflict` outcome — no force, no retry against a new head. A worktree sync failure AFTER
 * the ref moved is a DEGRADED SUCCESS (`landed_desynced`), never an ordinary failure. A post-CAS
 * reprobe that no longer confirms our commit/tree (another actor advanced the ref) is DEGRADED
 * (reconciliation required), never a clean success and never "nothing happened".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import { revParse, updateRefCas, commitTree, worktreeForBranch, isWorktreeClean, syncWorktreeToRef, gitCommonDir } from "../../core/workspace/git.js";
import type { JournalWriteStatus, PostCasReprobe, PromotionTarget, PromotionTargetRef, PublicationOutcome } from "../core/promotion.js";

/**
 * Where best-effort promotion intent/landed markers are written, for reconciliation + audit.
 *
 * BEST-EFFORT, not crash-durable (V2-016): each write RETURNS whether it succeeded, so the
 * publication result can report journal durability honestly. The git ref/tree remains the ONLY
 * authoritative landing proof — a journal failure never turns a landed CAS into a failure.
 */
export interface PublicationJournal {
  /** Write the pre-CAS intent (beforeRef, intended afterRef, candidate/disposition identity). Returns durability. */
  intent(record: Readonly<Record<string, string>>): JournalWriteStatus;
  /** Write the post-CAS landed marker. Returns durability. */
  landed(record: Readonly<Record<string, string>>): JournalWriteStatus;
}

/** A no-op journal — used by tests that do not assert durability. Reports `not_attempted`. */
export const NO_JOURNAL: PublicationJournal = { intent: () => "not_attempted", landed: () => "not_attempted" };

/**
 * A filesystem journal under a directory. Each publication writes `promotion-intent.json`
 * before the CAS and `promotion-landed.json` after. A write that fails returns `"failed"` so
 * the caller can mark the publication's journal durability truthfully — it is NEVER swallowed.
 */
export function createFilePublicationJournal(dir: string): PublicationJournal {
  const write = (name: string, record: Readonly<Record<string, string>>): JournalWriteStatus => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2), "utf8");
      return "written";
    } catch {
      // Best-effort: a journal write failure must not prevent/undo a publication (the git ref is
      // authoritative), but it is REPORTED rather than swallowed.
      return "failed";
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
    async repositoryIdentity(target: PromotionTargetRef): Promise<string | undefined> {
      // Canonical, symlink-resolved identity: git's common dir (stable across worktrees), then
      // realpath so a lexical alias resolves to the same identity and a swapped symlink to a
      // different repo resolves to a different identity.
      try {
        const common = await gitCommonDir(target.repositoryPath);
        try { return realpathSync(common); } catch { return common; }
      } catch {
        return undefined;
      }
    },

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

      // BEST-EFFORT INTENT before the irreversible CAS — its durability is REPORTED, not assumed.
      const journalIntentStatus = journal.intent({ beforeRef: expectedHead, afterRef: commit, publishedTree: candidateTreeId, targetBranch: target.baseBranch });

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
      const journalLandedStatus = journal.landed({ beforeRef: expectedHead, afterRef: commit, publishedTree: candidateTreeId, targetBranch: target.baseBranch });

      // FRESH POST-CAS REPROBE (V2-016): read the authoritative ref and its tree AGAIN, from git,
      // and require them to still be our commit/tree. A mismatch means another actor advanced the
      // ref between our CAS and now — a DEGRADED landing, never a clean success.
      const postCas = await reprobe(repo, target.baseBranch, commit, candidateTreeId);

      let worktreeSynced = false;
      let stashed = false;
      if (checkedOutPath !== undefined) {
        try {
          const sync = await syncWorktreeToRef(checkedOutPath, commit);
          worktreeSynced = true;
          stashed = sync.stashed;
        } catch (err) {
          return { kind: "landed_desynced", beforeRef: expectedHead, afterCommit: commit, publishedTree: candidateTreeId, detail: `the target ref moved ${expectedHead}→${commit} but the checked-out worktree at ${checkedOutPath} could not be synced: ${err instanceof Error ? err.message : String(err)}`, journalIntentStatus, journalLandedStatus, postCas };
        }
      }

      return { kind: "landed", beforeRef: expectedHead, afterCommit: commit, publishedTree: candidateTreeId, worktreeSynced, stashed, journalIntentStatus, journalLandedStatus, postCas };
    },
  };
}

/**
 * The fresh post-CAS reprobe: read `branch` and `branch^{tree}` AGAIN from git and confirm they
 * are still our `expectedCommit` / `expectedTree`. Any mismatch (or read failure) is reported as
 * unverified with the observed values — the caller degrades to reconciliation-required.
 */
async function reprobe(repo: string, branch: string, expectedCommit: string, expectedTree: string): Promise<PostCasReprobe> {
  let observedRef: string | undefined;
  let observedTree: string | undefined;
  try {
    observedRef = await revParse(repo, branch);
    observedTree = await revParse(repo, `${branch}^{tree}`);
  } catch (err) {
    return { verified: false, ...(observedRef !== undefined ? { observedRef } : {}), detail: `post-CAS reprobe could not read the target ref/tree: ${err instanceof Error ? err.message : String(err)}` };
  }
  const verified = observedRef === expectedCommit && observedTree === expectedTree;
  return {
    verified,
    observedRef,
    observedTree,
    ...(verified ? {} : { detail: `post-CAS reprobe: ref ${observedRef} (expected ${expectedCommit}), tree ${observedTree} (expected ${expectedTree})` }),
  };
}
