/**
 * ikbi `undo <receipt-id|commit>` — revert a promoted change (SG-3).
 *
 * Reads the promote receipt's reversibility hook (a `kind:"state"` change carrying
 * `target` = "<repo>#<branch>", `before.ref`, `after.ref`), then:
 *   1. CAS-resets the branch ref from after → before (refuses if it already moved on);
 *   2. brings the checked-out working tree back in sync (reuses syncWorktreeToRef — refuses
 *      if that tree is dirty, never clobbering uncommitted work);
 *   3. records the undo as a NEW receipt (`corrects` the original).
 *
 * Read-then-write over the receipt store + git; no model, no network.
 */

import { registerCommand } from "./registry.js";
import { config } from "../core/config.js";
import { resolveIdentity as coreResolveIdentity } from "../core/identity/index.js";
import type { IdentityClaim, ValidatedIdentity } from "../core/identity/index.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt, ReceiptInput, ReceiptQuery } from "../core/receipt/index.js";
import type { AgentIdentity } from "../core/identity/contract.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
import type { WorkspaceRecord } from "../core/workspace/contract.js";
import { isWorktreeClean as gitIsClean, revParse as gitRevParse, syncWorktreeToRef as gitSync, updateRefCas as gitCas, worktreeForBranch as gitWtForBranch, diffRange as gitDiffRange } from "../core/workspace/git.js";

/** The git surface undo drives (injectable for tests; defaults to the real worktree git). */
export interface UndoGit {
  revParse(repo: string, ref: string): Promise<string>;
  worktreeForBranch(repo: string, branch: string): Promise<string | undefined>;
  isWorktreeClean(worktreePath: string): Promise<boolean>;
  updateRefCas(repo: string, ref: string, newSha: string, oldSha: string): Promise<void>;
  syncWorktreeToRef(worktreePath: string, ref: string): Promise<void>;
  /** Optional: compute the diff between two refs (used for preview before revert). */
  gitDiff?(repo: string, fromRef: string, toRef: string): Promise<string>;
}

export interface UndoCliDeps {
  readonly receipts?: { query(filter?: ReceiptQuery): Promise<Receipt[]>; append(input: ReceiptInput, identity: AgentIdentity): Promise<Receipt> };
  readonly git?: UndoGit;
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  /**
   * The durable workspace registry — undo's RECOVERY source when the normal promote receipt is
   * missing (PROMOTED_BUT_RECEIPT_FAILED). A landed promote always writes a `promoted` record with
   * `promoteIntent.beforeRef` + `promotedTo`, so undo can revert even if the receipt append failed.
   */
  readonly workspaces?: { list(): Promise<WorkspaceRecord[]> };
}

/** A revertible promote resolved from EITHER a receipt or the durable workspace registry record. */
interface Revertible {
  readonly repo: string;
  readonly branch: string;
  readonly beforeRef: string;
  readonly afterRef: string;
  /** Receipt id to mark `corrects` on the undo receipt (when sourced from a receipt). */
  readonly correctsReceiptId?: string;
  readonly requestId?: string;
  readonly project?: string;
  /** Where the revert was resolved from — for the operator-facing message. */
  readonly source: "receipt" | "registry";
}

const defaultGit: UndoGit = {
  revParse: gitRevParse,
  worktreeForBranch: gitWtForBranch,
  isWorktreeClean: gitIsClean,
  updateRefCas: gitCas,
  syncWorktreeToRef: gitSync,
  gitDiff: (repo, from, to) => gitDiffRange(repo, from, to),
};

/** The revertible state change a promote receipt carries (kind "state", with before/after refs). */
function stateChange(r: Receipt): Receipt["changes"][number] | undefined {
  return r.changes.find((c) => c.kind === "state" && c.before?.ref !== undefined && c.after?.ref !== undefined && c.target.includes("#"));
}

const short = (sha: string): string => sha.slice(0, 8);

/** Build the `undo` handler. Defaults wire the live receipt store + real git. */
export function createUndoCli(deps: UndoCliDeps = {}) {
  const receipts = deps.receipts ?? coreReceipts;
  const workspaces = deps.workspaces ?? coreWorkspaces;
  const git = deps.git ?? defaultGit;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  function operator(): AgentIdentity | undefined {
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi undo: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return undefined;
    }
    try {
      return resolveIdentity({ token: operatorToken }).identity;
    } catch (e) {
      err(`ikbi undo: operator identity resolution failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return undefined;
    }
  }

  async function undo(argv: readonly string[]): Promise<void> {
    const useLatest = argv[0] === "--latest";
    const idArg = useLatest ? undefined : argv[0];

    if (!useLatest && (idArg === undefined || idArg.length === 0)) {
      err("ikbi undo: a receipt id or promoted commit is required — usage: ikbi undo <receipt-id|commit|--latest>\n");
      setExit(1);
      return;
    }

    // Auth check before any receipt or registry reads.
    const identity = operator();
    if (identity === undefined) return;

    let revertible: Revertible | undefined;

    if (useLatest) {
      revertible = await resolveLatest().catch(() => undefined);
      if (revertible === undefined) {
        err("ikbi undo: no revertible promotion found in the receipt log\n");
        setExit(1);
        return;
      }
    } else {
      // RESOLVE the revertible promote — from a receipt if one exists, else FALL BACK to the durable
      // workspace registry record (PROMOTED_BUT_RECEIPT_FAILED recovery). A receipt-log read failure is
      // NOT fatal: undo can still recover from the registry, so we try the registry before giving up.
      let receiptReadError: string | undefined;
      revertible = await resolveFromReceipt(idArg!).catch((e: unknown) => {
        receiptReadError = e instanceof Error ? e.message : String(e);
        return undefined;
      });
      if (revertible === undefined) {
        revertible = await resolveFromRegistry(idArg!).catch(() => undefined);
      }
      if (revertible === undefined) {
        if (receiptReadError !== undefined) {
          err(`ikbi undo: could not read the receipt log (${receiptReadError}) and no durable promote record matched "${idArg}"\n`);
        } else {
          err(`ikbi undo: no revertible promote found for "${idArg}" (a receipt id, a promoted commit sha, or a workspace id)\n`);
        }
        setExit(1);
        return;
      }
    }

    const { repo, branch, beforeRef, afterRef } = revertible;
    const targetSpec = `${repo}#${branch}`;

    // Show a preview of what will be reverted before touching anything.
    out(`Revert preview: "${branch}" in ${repo}\n`);
    out(`  promoted commit: ${short(afterRef)}  (will be reset to: ${short(beforeRef)})\n`);
    if (git.gitDiff !== undefined) {
      try {
        const diffText = await git.gitDiff(repo, beforeRef, afterRef);
        if (diffText.trim().length > 0) {
          const diffLines = diffText.split("\n");
          const truncated = diffLines.length > 50;
          out(`\nChanges that will be undone:\n`);
          out(diffLines.slice(0, 50).join("\n") + (truncated ? "\n... (truncated — run `git diff` for the full diff)\n" : "\n"));
        }
      } catch {
        // diff preview is best-effort — a missing worktree or git error must not block the revert
      }
    }
    out(`\n`);

    // The branch must still be AT the promoted commit — otherwise it moved on and a blind
    // reset would drop later work. Fail-closed (refuse) rather than clobber.
    let current: string;
    try {
      current = await git.revParse(repo, branch);
    } catch (e) {
      err(`ikbi undo: could not read ${branch} in ${repo}: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }
    if (current !== afterRef) {
      err(`ikbi undo: refusing — "${branch}" is at ${short(current)}, not the promoted ${short(afterRef)} (it moved on; undo would drop later work)\n`);
      setExit(1);
      return;
    }
    // Never clobber a dirty checked-out tree.
    const wt = await git.worktreeForBranch(repo, branch);
    if (wt !== undefined && !(await git.isWorktreeClean(wt))) {
      err(`ikbi undo: refusing — "${branch}" is checked out at ${wt} with uncommitted changes (commit or stash first)\n`);
      setExit(1);
      return;
    }

    out(`Safe to revert: branch is at the promoted commit${wt !== undefined ? ", worktree is clean" : ""}\n\n`);

    try {
      await git.updateRefCas(repo, `refs/heads/${branch}`, beforeRef, afterRef); // after → before, atomically
      if (wt !== undefined) await git.syncWorktreeToRef(wt, beforeRef); // working tree back to the prior ref
    } catch (e) {
      err(`ikbi undo: revert failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }

    await receipts.append(
      {
        operation: "workspace.undo",
        outcome: { status: "success", detail: `reverted ${branch} ${short(afterRef)} → ${short(beforeRef)}` },
        changes: [{ kind: "state", target: targetSpec, before: { ref: afterRef }, after: { ref: beforeRef }, inverse: { operation: "git.update-ref", args: { ref: `refs/heads/${branch}`, to: afterRef } } }],
        ...(revertible.correctsReceiptId !== undefined ? { corrects: revertible.correctsReceiptId } : {}),
        ...(revertible.requestId !== undefined ? { requestId: revertible.requestId } : {}),
        ...(revertible.project !== undefined ? { project: revertible.project } : {}),
      },
      identity,
    ).catch((e: unknown) => err(`ikbi undo: revert landed but recording the undo receipt failed: ${e instanceof Error ? e.message : String(e)}\n`));

    const via = revertible.source === "registry" ? "durable promote record (receipt was missing — PROMOTED_BUT_RECEIPT_FAILED recovery)" : `receipt ${revertible.correctsReceiptId}`;
    out(`undone: "${branch}" reset ${short(afterRef)} → ${short(beforeRef)} (reverting ${via})\n`);
  }

  /** Resolve the most recent revertible promote from the receipt log (for `--latest`). */
  async function resolveLatest(): Promise<Revertible | undefined> {
    const all = await receipts.query();
    const promotes = all
      .filter((r) => r.operation === "workspace.promote" && r.outcome.status === "success" && stateChange(r) !== undefined)
      .sort((a, b) => b.seq - a.seq);
    const latest = promotes[0];
    if (latest === undefined) return undefined;
    const ch = stateChange(latest)!;
    const hashIdx = ch.target.lastIndexOf("#");
    const repo = ch.target.slice(0, hashIdx);
    const branch = ch.target.slice(hashIdx + 1);
    if (repo.length === 0 || branch.length === 0) return undefined;
    return {
      repo,
      branch,
      beforeRef: ch.before!.ref as string,
      afterRef: ch.after!.ref as string,
      correctsReceiptId: latest.id,
      ...(latest.requestId !== undefined ? { requestId: latest.requestId } : {}),
      ...(latest.project !== undefined ? { project: latest.project } : {}),
      source: "receipt",
    };
  }

  /** Resolve a revertible promote from the receipt log (by receipt id, else by promoted commit). */
  async function resolveFromReceipt(idArg: string): Promise<Revertible | undefined> {
    const all = await receipts.query();
    const target =
      all.find((r) => r.id === idArg && stateChange(r) !== undefined) ??
      all.find((r) => stateChange(r)?.after?.ref === idArg);
    if (target === undefined) return undefined;
    const ch = stateChange(target)!;
    const hashIdx = ch.target.lastIndexOf("#");
    const repo = ch.target.slice(0, hashIdx);
    const branch = ch.target.slice(hashIdx + 1);
    if (repo.length === 0 || branch.length === 0) return undefined;
    return {
      repo,
      branch,
      beforeRef: ch.before!.ref as string,
      afterRef: ch.after!.ref as string,
      correctsReceiptId: target.id,
      ...(target.requestId !== undefined ? { requestId: target.requestId } : {}),
      ...(target.project !== undefined ? { project: target.project } : {}),
      source: "receipt",
    };
  }

  /**
   * Resolve a revertible promote from the DURABLE workspace registry — the recovery path when the
   * normal promote receipt never landed. Matches a `promoted` record by its promoted commit
   * (`promotedTo`/intent afterRef) or by workspace id, and reconstructs the revert from the durable
   * before/after refs the manager wrote BEFORE moving the branch.
   */
  async function resolveFromRegistry(idArg: string): Promise<Revertible | undefined> {
    let records: WorkspaceRecord[];
    try {
      records = await workspaces.list();
    } catch {
      return undefined;
    }
    const candidates = records.filter((r) => r.state === "promoted");
    const pick = (r: WorkspaceRecord): { before: string; after: string } | undefined => {
      const after = r.promotedTo ?? r.promoteIntent?.afterRef;
      const before = r.promoteIntent?.beforeRef;
      return after !== undefined && before !== undefined ? { before, after } : undefined;
    };
    // Prefer an exact workspace-id match, else match by the promoted commit.
    const byId = candidates.find((r) => r.id === idArg && pick(r) !== undefined);
    const byCommit = candidates.find((r) => pick(r)?.after === idArg);
    const rec = byId ?? byCommit;
    if (rec === undefined) return undefined;
    const refs = pick(rec)!;
    return {
      repo: rec.targetRepo,
      branch: rec.baseBranch,
      beforeRef: refs.before,
      afterRef: refs.after,
      source: "registry",
    };
  }

  return { undo };
}

registerCommand({
  name: "undo",
  summary: "Revert a promoted change (shows preview + diff before reverting)",
  usage: "ikbi undo <receipt-id|commit|--latest>",
  run: (argv) => createUndoCli().undo(argv),
});
