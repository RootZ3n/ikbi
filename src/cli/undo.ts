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
import { isWorktreeClean as gitIsClean, revParse as gitRevParse, syncWorktreeToRef as gitSync, updateRefCas as gitCas, worktreeForBranch as gitWtForBranch } from "../core/workspace/git.js";

/** The git surface undo drives (injectable for tests; defaults to the real worktree git). */
export interface UndoGit {
  revParse(repo: string, ref: string): Promise<string>;
  worktreeForBranch(repo: string, branch: string): Promise<string | undefined>;
  isWorktreeClean(worktreePath: string): Promise<boolean>;
  updateRefCas(repo: string, ref: string, newSha: string, oldSha: string): Promise<void>;
  syncWorktreeToRef(worktreePath: string, ref: string): Promise<void>;
}

export interface UndoCliDeps {
  readonly receipts?: { query(filter?: ReceiptQuery): Promise<Receipt[]>; append(input: ReceiptInput, identity: AgentIdentity): Promise<Receipt> };
  readonly git?: UndoGit;
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

const defaultGit: UndoGit = {
  revParse: gitRevParse,
  worktreeForBranch: gitWtForBranch,
  isWorktreeClean: gitIsClean,
  updateRefCas: gitCas,
  syncWorktreeToRef: gitSync,
};

/** The revertible state change a promote receipt carries (kind "state", with before/after refs). */
function stateChange(r: Receipt): Receipt["changes"][number] | undefined {
  return r.changes.find((c) => c.kind === "state" && c.before?.ref !== undefined && c.after?.ref !== undefined && c.target.includes("#"));
}

const short = (sha: string): string => sha.slice(0, 8);

/** Build the `undo` handler. Defaults wire the live receipt store + real git. */
export function createUndoCli(deps: UndoCliDeps = {}) {
  const receipts = deps.receipts ?? coreReceipts;
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
    const idArg = argv[0];
    if (idArg === undefined || idArg.length === 0) {
      err("ikbi undo: a receipt id or promoted commit is required — usage: ikbi undo <receipt-id|commit>\n");
      setExit(1);
      return;
    }
    const identity = operator();
    if (identity === undefined) return;
    let all: Receipt[];
    try {
      all = await receipts.query();
    } catch (e) {
      err(`ikbi undo: could not read the receipt log: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }
    // Match by receipt id first, else by the promoted (after) commit it landed.
    const target =
      all.find((r) => r.id === idArg && stateChange(r) !== undefined) ??
      all.find((r) => stateChange(r)?.after?.ref === idArg);
    if (target === undefined) {
      err(`ikbi undo: no revertible promote found for "${idArg}" (a receipt id or a promoted commit sha)\n`);
      setExit(1);
      return;
    }
    const ch = stateChange(target)!;
    const beforeRef = ch.before!.ref as string;
    const afterRef = ch.after!.ref as string;
    const hashIdx = ch.target.lastIndexOf("#");
    const repo = ch.target.slice(0, hashIdx);
    const branch = ch.target.slice(hashIdx + 1);
    if (repo.length === 0 || branch.length === 0) {
      err(`ikbi undo: receipt ${target.id} has a malformed change target ("${ch.target}")\n`);
      setExit(1);
      return;
    }

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
        changes: [{ kind: "state", target: ch.target, before: { ref: afterRef }, after: { ref: beforeRef }, inverse: { operation: "git.update-ref", args: { ref: `refs/heads/${branch}`, to: afterRef } } }],
        corrects: target.id,
        ...(target.requestId !== undefined ? { requestId: target.requestId } : {}),
        ...(target.project !== undefined ? { project: target.project } : {}),
      },
      identity,
    ).catch((e: unknown) => err(`ikbi undo: revert landed but recording the undo receipt failed: ${e instanceof Error ? e.message : String(e)}\n`));

    out(`undone: "${branch}" reset ${short(afterRef)} → ${short(beforeRef)} (reverting receipt ${target.id})\n`);
  }

  return { undo };
}

registerCommand({
  name: "undo",
  summary: "Revert a promoted change by receipt id or promoted commit",
  usage: "ikbi undo <receipt-id|commit>",
  run: (argv) => createUndoCli().undo(argv),
});
