/**
 * THE ORPHAN CENSUS — a read-only account of what a repository's workspace bookkeeping actually
 * contains, and a cleanup plan derived from it.
 *
 * WHY THIS EXISTS. `cleanOrphans` discovered the repositories it swept by walking the ikbi
 * WORKSPACE RECORD STORE. That works for the case it was written for — a crashed run whose record
 * survives — and fails completely for the case that actually accumulated: a run whose STATE ROOT
 * was deleted. With no record there is no repo to visit, so the git-side registration and the
 * scratch branch stay behind, and nothing ikbi can run will ever find them again. The canonical
 * checkout reached 164 registrations, 143 of which git itself marks prunable, and 165 live
 * `ikbi/ws/*` refs. `git branch` stopped being readable.
 *
 * OWNERSHIP IS EVIDENCE, NOT A NAME. Anyone can create a branch called `ikbi/ws/deadbeef`, and a
 * cleanup that force-deletes on the strength of a prefix is a deletion primitive wearing a
 * hygiene costume. Ownership here is bound from what the system actually recorded:
 *
 *   record        — an ikbi workspace record names this branch/path. Strongest: ikbi wrote it down.
 *   registration  — git holds a worktree registration pairing this path with a namespaced branch.
 *                   ikbi created that pairing through `git worktree add`; a hand-made branch has
 *                   no registration.
 *   namespace_only— the branch merely LOOKS like ikbi's. That is not evidence, it is a coincidence
 *                   or a forgery, and it is classified AMBIGUOUS and never removed.
 *
 * WHAT THE PLAN WILL NOT DO. It never removes a registration whose directory exists, never touches
 * a locked worktree, never deletes a branch outside the namespace, and never deletes a branch
 * holding commits that are reachable from nowhere else — those are reported so an operator can
 * rescue them first. Two such branches existed in the canonical checkout when this was written;
 * the pre-existing `reclaim()` path would have force-deleted both.
 *
 * The census is READ-ONLY. Producing a plan changes nothing; `applyCleanupPlan` is a separate,
 * explicit step, and it re-verifies every observation before acting on it.
 */

import { SCRATCH_BRANCH_PREFIX } from "./contract.js";
import type { WorkspaceRecord } from "./contract.js";
import { listWorktrees, runGit, type WorktreeEntry } from "./git.js";

/** How an entry's ikbi ownership was established. Ordered strongest → weakest. */
export type OwnershipEvidence = "record" | "registration" | "namespace_only" | "none";

/** Whether ikbi may act on an entry at all. */
export type Ownership = "ikbi" | "foreign" | "ambiguous";

/** What the registration itself is. */
export type RegistrationClass = "live" | "missing_directory" | "locked";

/** What the plan proposes for one entry. */
export type CensusAction = "keep" | "prune_registration" | "delete_branch" | "report_only";

export interface WorktreeCensusEntry {
  readonly path: string;
  readonly branch?: string;
  readonly head?: string;
  /** True when the worktree directory is present on disk right now. */
  readonly directoryExists: boolean;
  /** Git's own lock reason, when the worktree is locked (empty string = locked, no reason given). */
  readonly locked?: string;
  /** Git's own prunable reason, when git judges the administrative entry droppable. */
  readonly prunableReason?: string;
  readonly registration: RegistrationClass;
  /** Whether an ikbi workspace record was found for this path/branch. */
  readonly record: "present" | "absent";
  readonly recordState?: string;
  readonly ownership: Ownership;
  readonly ownershipEvidence: OwnershipEvidence;
  readonly action: CensusAction;
  /** Every reason that produced `action`, in the order they were decided. */
  readonly reasons: readonly string[];
}

export interface BranchCensusEntry {
  readonly branch: string;
  /** The commit the ref points at when the census was taken. Re-checked before any deletion. */
  readonly tip: string;
  readonly inNamespace: boolean;
  /** True when some worktree registration currently holds this branch checked out. */
  readonly heldByWorktree: boolean;
  /** True when that holding worktree's directory still exists. */
  readonly heldByLiveWorktree: boolean;
  readonly record: "present" | "absent";
  readonly ownership: Ownership;
  readonly ownershipEvidence: OwnershipEvidence;
  /** Commits on this branch reachable from NO protected ref. Non-zero ⇒ never auto-deleted. */
  readonly uniqueCommits: number;
  /** A short sample of those commits, so the report can name what would be lost. */
  readonly uniqueCommitSample: readonly string[];
  readonly action: CensusAction;
  readonly reasons: readonly string[];
}

/**
 * One unit of cleanup. Steps are ordered: a branch cannot be deleted while a registration still
 * holds it checked out, so every `prune_registration` precedes every `delete_branch`.
 */
export interface CleanupStep {
  readonly kind: "prune_registration" | "delete_branch";
  /** Registration path, or branch name. */
  readonly target: string;
  /** The observation this step is authorized by, re-verified at apply time. */
  readonly observed: { readonly tip?: string; readonly prunableReason?: string };
  readonly reason: string;
}

export interface OrphanCensus {
  readonly repositoryPath: string;
  readonly takenAt: number;
  readonly worktrees: readonly WorktreeCensusEntry[];
  readonly branches: readonly BranchCensusEntry[];
  /** The refs whose reachability protects a commit from being called unique. */
  readonly protectedRefs: readonly string[];
  readonly summary: {
    readonly registrations: number;
    readonly liveRegistrations: number;
    readonly missingDirectory: number;
    readonly lockedRegistrations: number;
    readonly namespaceBranches: number;
    readonly foreignBranches: number;
    readonly ambiguous: number;
    readonly branchesWithUniqueCommits: number;
    readonly prunableRegistrations: number;
    readonly deletableBranches: number;
  };
  /** The ordered, minimal cleanup this census authorizes. Empty when there is nothing safe to do. */
  readonly plan: readonly CleanupStep[];
}

/** Injectable filesystem probe, so fixtures can model a path that vanishes mid-run. */
export interface CensusProbes {
  readonly pathExists: (p: string) => Promise<boolean> | boolean;
}

const defaultProbes: CensusProbes = {
  pathExists: async (p: string): Promise<boolean> => {
    const { access } = await import("node:fs/promises");
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
};

/** Every local/remote/tag ref EXCEPT the workspace namespace — reachability from these is safety. */
async function protectedRefs(repo: string): Promise<string[]> {
  const r = await runGit(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/", "refs/tags/"]);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(`refs/heads/${SCRATCH_BRANCH_PREFIX}`));
}

/** Branches in the workspace namespace, with their tips. */
async function namespaceBranches(repo: string): Promise<{ branch: string; tip: string }[]> {
  const r = await runGit(repo, ["for-each-ref", "--format=%(refname:short) %(objectname)", `refs/heads/${SCRATCH_BRANCH_PREFIX}`]);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const [branch, tip] = l.split(" ");
      return { branch: branch ?? "", tip: tip ?? "" };
    })
    .filter((b) => b.branch.length > 0);
}

/**
 * Commits on `branch` reachable from none of `protect`. This is the question that decides whether
 * deleting a ref loses work, and it is asked per branch rather than inferred from the branch's age
 * or name.
 */
async function uniqueCommits(repo: string, branch: string, protect: readonly string[]): Promise<{ count: number; sample: string[] }> {
  if (protect.length === 0) {
    // Nothing to be reachable FROM: treat every commit as unique rather than as safe.
    const all = await runGit(repo, ["rev-list", "--count", branch], { okCodes: [128] });
    const count = Number(all.stdout.trim() || "0");
    return { count, sample: [] };
  }
  const r = await runGit(repo, ["rev-list", "--format=%h %s", branch, "--not", ...protect], { okCodes: [128] });
  if (r.code !== 0) return { count: 0, sample: [] };
  const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
  // `--format` emits a "commit <sha>" header line per commit followed by the formatted line.
  const formatted = lines.filter((l) => !l.startsWith("commit "));
  return { count: formatted.length, sample: formatted.slice(0, 5) };
}

/**
 * Take the census. READ-ONLY: it runs only `for-each-ref`, `worktree list` and `rev-list`, and
 * writes nothing. `records` is whatever the workspace store still holds — an empty list is the
 * normal case for the orphans this exists to find, and is not an error.
 */
export async function takeOrphanCensus(
  repositoryPath: string,
  records: readonly WorkspaceRecord[],
  opts: { readonly probes?: CensusProbes; readonly now?: () => number } = {},
): Promise<OrphanCensus> {
  const probes = opts.probes ?? defaultProbes;
  const now = opts.now ?? Date.now;

  const registrations: WorktreeEntry[] = await listWorktrees(repositoryPath);
  const protect = await protectedRefs(repositoryPath);
  const branches = await namespaceBranches(repositoryPath);

  const recordsByBranch = new Map<string, WorkspaceRecord>();
  const recordsByPath = new Map<string, WorkspaceRecord>();
  for (const rec of records) {
    recordsByBranch.set(rec.scratchBranch, rec);
    recordsByPath.set(rec.path, rec);
  }

  // ── worktree registrations ────────────────────────────────────────────────
  const worktrees: WorktreeCensusEntry[] = [];
  for (const w of registrations) {
    const directoryExists = await probes.pathExists(w.path);
    const rec = recordsByPath.get(w.path) ?? (w.branch !== undefined ? recordsByBranch.get(w.branch) : undefined);
    const inNamespace = w.branch !== undefined && w.branch.startsWith(SCRATCH_BRANCH_PREFIX);

    const registration: RegistrationClass =
      w.locked !== undefined ? "locked" : directoryExists ? "live" : "missing_directory";

    let ownership: Ownership;
    let evidence: OwnershipEvidence;
    if (rec !== undefined) {
      ownership = "ikbi";
      evidence = "record";
    } else if (inNamespace) {
      // A worktree REGISTRATION pairing this path with a namespaced branch is something ikbi
      // created through `git worktree add`. A hand-made branch has no registration at all.
      ownership = "ikbi";
      evidence = "registration";
    } else {
      ownership = "foreign";
      evidence = "none";
    }

    const reasons: string[] = [];
    let action: CensusAction = "keep";
    if (ownership === "foreign") {
      reasons.push("not an ikbi workspace registration — outside ikbi's authority");
      action = "keep";
    } else if (registration === "locked") {
      reasons.push(`worktree is LOCKED${w.locked ? ` (${w.locked})` : ""} — an operator protected it; never removed automatically`);
      action = "report_only";
    } else if (directoryExists) {
      reasons.push("the worktree directory exists — it may hold the only copy of uncommitted work");
      action = "keep";
    } else if (w.prunable !== undefined) {
      reasons.push(`git reports the administrative entry prunable: ${w.prunable}`);
      action = "prune_registration";
    } else {
      // Directory gone but git has not (yet) judged it prunable: report rather than guess.
      reasons.push("the directory is missing but git does not report the entry prunable — ambiguous");
      ownership = "ambiguous";
      evidence = evidence === "record" ? "record" : "namespace_only";
      action = "report_only";
    }

    worktrees.push({
      path: w.path,
      ...(w.branch !== undefined ? { branch: w.branch } : {}),
      ...(w.head !== undefined ? { head: w.head } : {}),
      directoryExists,
      ...(w.locked !== undefined ? { locked: w.locked } : {}),
      ...(w.prunable !== undefined ? { prunableReason: w.prunable } : {}),
      registration,
      record: rec !== undefined ? "present" : "absent",
      ...(rec !== undefined ? { recordState: rec.state } : {}),
      ownership,
      ownershipEvidence: evidence,
      action,
      reasons,
    });
  }

  // ── namespace branches ────────────────────────────────────────────────────
  const heldBranches = new Map<string, WorktreeCensusEntry>();
  for (const w of worktrees) if (w.branch !== undefined) heldBranches.set(w.branch, w);

  const branchEntries: BranchCensusEntry[] = [];
  for (const { branch, tip } of branches) {
    const holder = heldBranches.get(branch);
    const rec = recordsByBranch.get(branch);
    const unique = await uniqueCommits(repositoryPath, branch, protect);

    let ownership: Ownership;
    let evidence: OwnershipEvidence;
    if (rec !== undefined) {
      ownership = "ikbi";
      evidence = "record";
    } else if (holder !== undefined) {
      ownership = "ikbi";
      evidence = "registration";
    } else {
      // In the namespace, but nothing ikbi recorded and nothing git registered vouches for it.
      // A forged `ikbi/ws/*` branch is indistinguishable from this, so it is never removed.
      ownership = "ambiguous";
      evidence = "namespace_only";
    }

    // EVERY applicable reason is recorded, not just the first one to fire. A branch is often
    // withheld for more than one cause — unproven ownership AND unique commits — and a report that
    // named only the first would tell the operator to fix one problem and leave the other unseen.
    const reasons: string[] = [];
    if (ownership === "ambiguous") {
      reasons.push("in the ikbi namespace but no workspace record and no worktree registration vouches for it — ownership unproven");
    }
    if (holder !== undefined && holder.directoryExists) {
      reasons.push(`checked out by a live worktree at ${holder.path}`);
    }
    if (holder !== undefined && holder.registration === "locked") {
      reasons.push("held by a LOCKED worktree");
    }
    if (unique.count > 0) {
      reasons.push(`holds ${unique.count} commit(s) reachable from no other ref — deleting this ref would lose them`);
    }

    // The action is the SAFEST verdict any reason implies. Deletion is reached only when nothing
    // objected at all.
    let action: CensusAction;
    if (holder !== undefined && holder.directoryExists) {
      action = "keep";
    } else if (reasons.length > 0) {
      action = "report_only";
    } else {
      reasons.push("fully reachable from protected history — the ref carries no unique work");
      action = "delete_branch";
    }

    branchEntries.push({
      branch,
      tip,
      inNamespace: true,
      heldByWorktree: holder !== undefined,
      heldByLiveWorktree: holder !== undefined && holder.directoryExists,
      record: rec !== undefined ? "present" : "absent",
      ownership,
      ownershipEvidence: evidence,
      uniqueCommits: unique.count,
      uniqueCommitSample: unique.sample,
      action,
      reasons,
    });
  }

  // ── the ordered plan ──────────────────────────────────────────────────────
  // REGISTRATIONS FIRST: git refuses to delete a branch a registration still holds, so pruning
  // has to happen before the branch step or every deletion behind it fails.
  const plan: CleanupStep[] = [];
  for (const w of worktrees) {
    if (w.action !== "prune_registration") continue;
    plan.push({
      kind: "prune_registration",
      target: w.path,
      observed: { ...(w.prunableReason !== undefined ? { prunableReason: w.prunableReason } : {}) },
      reason: w.reasons[0] ?? "prunable registration",
    });
  }
  for (const b of branchEntries) {
    if (b.action !== "delete_branch") continue;
    plan.push({ kind: "delete_branch", target: b.branch, observed: { tip: b.tip }, reason: b.reasons[0] ?? "no unique commits" });
  }

  return {
    repositoryPath,
    takenAt: now(),
    worktrees,
    branches: branchEntries,
    protectedRefs: protect,
    summary: {
      registrations: worktrees.length,
      liveRegistrations: worktrees.filter((w) => w.registration === "live").length,
      missingDirectory: worktrees.filter((w) => w.registration === "missing_directory").length,
      lockedRegistrations: worktrees.filter((w) => w.registration === "locked").length,
      namespaceBranches: branchEntries.length,
      foreignBranches: worktrees.filter((w) => w.ownership === "foreign").length,
      ambiguous: worktrees.filter((w) => w.ownership === "ambiguous").length + branchEntries.filter((b) => b.ownership === "ambiguous").length,
      branchesWithUniqueCommits: branchEntries.filter((b) => b.uniqueCommits > 0).length,
      prunableRegistrations: worktrees.filter((w) => w.action === "prune_registration").length,
      deletableBranches: branchEntries.filter((b) => b.action === "delete_branch").length,
    },
    plan,
  };
}

/** What happened to one planned step. */
export interface CleanupStepOutcome {
  readonly step: CleanupStep;
  readonly outcome: "applied" | "skipped_changed" | "skipped_unsafe" | "failed";
  /** Why, always — a skip that does not say why is indistinguishable from a silent failure. */
  readonly detail: string;
}

export interface CleanupApplication {
  readonly repositoryPath: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly outcomes: readonly CleanupStepOutcome[];
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
}

/** The receipt sink. Every removal emits one; a skip emits one too, so the trail is complete. */
export interface CleanupReceipts {
  readonly record: (outcome: CleanupStepOutcome) => Promise<void> | void;
}

/**
 * How the repository's PRUNABLE SET differs from the one the plan was approved against.
 *
 * WHY THIS IS NEEDED. `git worktree prune` has no per-path form: it drops every administrative
 * entry git currently judges prunable, repo-wide. Pruning "the 143 entries in the manifest" is
 * therefore not what the command does — it prunes whatever is prunable at the moment it runs. A
 * new orphan appearing between approval and application would be swept along, unreviewed, on the
 * authority of an approval that never covered it.
 *
 * That is not hypothetical here: running ikbi's own test suite creates fresh orphan registrations
 * in the canonical checkout, so the eligible set drifts on ordinary development activity.
 *
 * The only precise alternative is deleting `$GIT_COMMON_DIR/worktrees/<name>` by hand, which
 * hard-codes git's internal on-disk layout. So the broad command is kept and BOUNDED: the set is
 * recomputed under the reclaim lock immediately before the prune, and anything added, missing or
 * changed aborts the whole application rather than proceeding on a stale approval.
 */
export interface PruneEligibilityDrift {
  /** Prunable now, absent from the approved plan — would be swept unreviewed. */
  readonly added: readonly string[];
  /** In the approved plan, no longer prunable (or no longer registered at all). */
  readonly missing: readonly string[];
  /** Present in both, but git's stated reason changed — a different fact than the one approved. */
  readonly changed: readonly { readonly path: string; readonly was: string; readonly now: string }[];
}

/** True when the live set is byte-for-byte the approved one. The operator proof asserts THIS. */
export function pruneEligibilityMatches(drift: PruneEligibilityDrift): boolean {
  return drift.added.length === 0 && drift.missing.length === 0 && drift.changed.length === 0;
}

/**
 * True when the broad prune may run: nothing was ADDED and nothing CHANGED.
 *
 * MISSING IS NOT DRIFT, and the distinction is the whole point of the gate rather than a
 * loosening of it. This gate exists to bound what a repo-wide `git worktree prune` can sweep.
 * `added` and `changed` EXPAND that blast radius past what was approved, so either one aborts.
 * `missing` SHRINKS it — the entry git would have pruned no longer exists, so the command cannot
 * touch it however it behaves.
 *
 * Treating `missing` as an abort would also make an idempotent re-run impossible: a plan that
 * applied successfully leaves every one of its targets missing, so the second run of a completed
 * cleanup would refuse itself and report a drift that is really just its own success. A partially
 * applied plan — interrupted midway — is resumed for the same reason.
 */
export function pruneEligibilityIsSafe(drift: PruneEligibilityDrift): boolean {
  return drift.added.length === 0 && drift.changed.length === 0;
}

/**
 * Recompute the eligible prunable set from git and compare it to the plan's prune steps.
 * READ-ONLY — it decides whether the broad prune may run, and never runs it.
 */
export async function comparePruneEligibility(
  repositoryPath: string,
  plan: readonly CleanupStep[],
): Promise<PruneEligibilityDrift> {
  const approved = new Map<string, string>();
  for (const s of plan) {
    if (s.kind !== "prune_registration") continue;
    approved.set(s.target, s.observed.prunableReason ?? "");
  }
  const live = new Map<string, string>();
  for (const w of await listWorktrees(repositoryPath)) {
    if (w.prunable !== undefined) live.set(w.path, w.prunable);
  }
  const added: string[] = [];
  const missing: string[] = [];
  const changed: { path: string; was: string; now: string }[] = [];
  for (const [path, reason] of live) {
    const was = approved.get(path);
    if (was === undefined) added.push(path);
    else if (was !== reason) changed.push({ path, was, now: reason });
  }
  for (const path of approved.keys()) if (!live.has(path)) missing.push(path);
  return { added: added.sort(), missing: missing.sort(), changed };
}

/**
 * Apply a plan. NOT part of taking the census: a census is an observation, this is an action, and
 * keeping them separate is what makes dry-run the default rather than a flag someone can forget.
 *
 * EVERY STEP RE-VERIFIES ITS OWN OBSERVATION IMMEDIATELY BEFORE ACTING. A census is a snapshot,
 * and between snapshot and apply a path can be RECREATED by a new run that legitimately owns it,
 * or a branch can be advanced. Acting on the stale observation would then destroy live work while
 * believing it was reaping an orphan. So:
 *
 *   prune_registration — re-list the worktrees and require the entry to still be registered, still
 *                        prunable, and its directory still absent. A recreated directory means a
 *                        live worktree now owns that path: skip.
 *   delete_branch      — re-read the ref and require the tip to be EXACTLY the censused tip, then
 *                        re-check that it still holds no unique commits. An advanced branch is new
 *                        work: skip.
 *
 * Each step is independent and idempotent — a target that is already gone counts as applied, not
 * failed — so a partial run is resumed simply by taking a fresh census and applying again.
 */
export async function applyCleanupPlan(
  repositoryPath: string,
  plan: readonly CleanupStep[],
  opts: { readonly receipts?: CleanupReceipts; readonly probes?: CensusProbes; readonly now?: () => number } = {},
): Promise<CleanupApplication> {
  const probes = opts.probes ?? defaultProbes;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const outcomes: CleanupStepOutcome[] = [];

  const emit = async (step: CleanupStep, outcome: CleanupStepOutcome["outcome"], detail: string): Promise<void> => {
    const rec: CleanupStepOutcome = { step, outcome, detail };
    outcomes.push(rec);
    await opts.receipts?.record(rec);
  };

  const protect = await protectedRefs(repositoryPath);
  const pruneSteps = plan.filter((s) => s.kind === "prune_registration");

  /*
    THE BROAD-PRUNE GATE. `git worktree prune` is repo-wide and has no per-path form, so before it
    may run the eligible set is recomputed and required to EXACTLY equal the approved one. An
    entry that appeared since the census would otherwise be swept on an approval that never
    covered it. Any drift aborts the ENTIRE application — including the branch deletions, which
    are ordered after the prunes and would fail anyway with their registrations still in place.
  */
  let pruneBarrier: string | undefined;
  if (pruneSteps.length > 0) {
    const drift = await comparePruneEligibility(repositoryPath, plan);
    if (!pruneEligibilityIsSafe(drift)) {
      pruneBarrier =
        `the repository's prunable set no longer matches the approved plan — ` +
        `${drift.added.length} added, ${drift.changed.length} changed ` +
        `(${drift.missing.length} already applied). Re-take the census and obtain fresh approval.` +
        (drift.added.length > 0 ? ` First added: ${drift.added[0] ?? ""}` : "") +
        (drift.changed.length > 0 ? ` First changed: ${drift.changed[0]?.path ?? ""}` : "");
    }
  }
  if (pruneBarrier !== undefined) {
    for (const step of plan) await emit(step, "skipped_unsafe", pruneBarrier);
    return {
      repositoryPath,
      startedAt,
      finishedAt: now(),
      outcomes,
      applied: 0,
      skipped: outcomes.length,
      failed: 0,
    };
  }

  /** The broad prune runs AT MOST ONCE, after the gate above bounded what it can touch. */
  let prunedAlready = false;

  for (const step of plan) {
    try {
      if (step.kind === "prune_registration") {
        const live = await listWorktrees(repositoryPath);
        const entry = live.find((w) => w.path === step.target);
        if (entry === undefined) {
          await emit(step, "applied", "the registration was already gone (idempotent re-run)");
          continue;
        }
        if (await probes.pathExists(step.target)) {
          await emit(step, "skipped_changed", "the worktree directory EXISTS now — the path was recreated since the census; a live worktree owns it");
          continue;
        }
        if (entry.locked !== undefined) {
          await emit(step, "skipped_unsafe", "the registration is LOCKED now — never removed automatically");
          continue;
        }
        if (entry.prunable === undefined) {
          await emit(step, "skipped_changed", "git no longer reports this entry prunable");
          continue;
        }
        if (!prunedAlready) {
          await runGit(repositoryPath, ["worktree", "prune"]);
          prunedAlready = true;
        }
        await emit(step, "applied", `pruned the administrative entry (${entry.prunable})`);
        continue;
      }

      // delete_branch
      const show = await runGit(repositoryPath, ["rev-parse", "--verify", `refs/heads/${step.target}`], { okCodes: [128, 1] });
      if (show.code !== 0) {
        await emit(step, "applied", "the branch was already gone (idempotent re-run)");
        continue;
      }
      const tip = show.stdout.trim();
      if (step.observed.tip !== undefined && tip !== step.observed.tip) {
        await emit(step, "skipped_changed", `the branch moved since the census (${step.observed.tip.slice(0, 12)} → ${tip.slice(0, 12)}) — it is not the ref that was censused`);
        continue;
      }
      const held = (await listWorktrees(repositoryPath)).find((w) => w.branch === step.target);
      if (held !== undefined && (await probes.pathExists(held.path))) {
        await emit(step, "skipped_changed", `a live worktree at ${held.path} holds this branch now`);
        continue;
      }
      const unique = await uniqueCommits(repositoryPath, step.target, protect);
      if (unique.count > 0) {
        await emit(step, "skipped_unsafe", `the branch now holds ${unique.count} commit(s) reachable from no other ref — refusing to delete work`);
        continue;
      }
      await runGit(repositoryPath, ["branch", "-D", step.target], { okCodes: [1] });
      await emit(step, "applied", `deleted ref refs/heads/${step.target} at ${tip.slice(0, 12)} (fully reachable from protected history)`);
    } catch (err) {
      // A failure on one step must not abandon the rest: the plan is a set of independent,
      // idempotent removals, so the run continues and the failure is reported in its receipt.
      await emit(step, "failed", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    repositoryPath,
    startedAt,
    finishedAt: now(),
    outcomes,
    applied: outcomes.filter((o) => o.outcome === "applied").length,
    skipped: outcomes.filter((o) => o.outcome === "skipped_changed" || o.outcome === "skipped_unsafe").length,
    failed: outcomes.filter((o) => o.outcome === "failed").length,
  };
}
