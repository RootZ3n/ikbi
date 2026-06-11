/**
 * ikbi workspace primitive — git worktree mechanics.
 *
 * Thin, safe wrapper over the `git` CLI (array args via execFile — no shell, no
 * injection). Worktrees give isolation; the promote path computes the merge
 * OFF-worktree (`merge-tree --write-tree` + `commit-tree`) and lands it via a
 * single compare-and-swap `update-ref`, so the target is never half-merged.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { WorkspaceError } from "./contract.js";

const exec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Run a git command in `cwd`. Throws WorkspaceError("git") on non-zero unless the code is in `okCodes`. */
export async function runGit(cwd: string, args: readonly string[], opts?: { okCodes?: readonly number[] }): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", args as string[], { cwd, maxBuffer: MAX_BUFFER });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    const code = typeof e.code === "number" ? e.code : 1;
    if (opts?.okCodes?.includes(code)) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code };
    }
    throw new WorkspaceError("git", `git ${args.join(" ")} failed (code ${code}): ${(e.stderr ?? "").trim().slice(0, 500)}`, { cause: err });
  }
}

export async function isGitRepo(repo: string): Promise<boolean> {
  const r = await runGit(repo, ["rev-parse", "--is-inside-work-tree"], { okCodes: [128] }).catch(() => undefined);
  return r !== undefined && r.code === 0 && r.stdout.trim() === "true";
}

export async function currentBranch(repo: string): Promise<string> {
  const r = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.stdout.trim();
}

export async function revParse(repo: string, ref: string): Promise<string> {
  const r = await runGit(repo, ["rev-parse", ref]);
  return r.stdout.trim();
}

/** True if `ancestor` is an ancestor of `descendant`. */
export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  const r = await runGit(repo, ["merge-base", "--is-ancestor", ancestor, descendant], { okCodes: [1] });
  return r.code === 0;
}

export async function addWorktree(repo: string, path: string, branch: string, baseBranch: string): Promise<void> {
  await runGit(repo, ["worktree", "add", "--quiet", path, "-b", branch, baseBranch]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  // code 128 if the worktree path is already gone — tolerate (prune handles the admin entry).
  await runGit(repo, ["worktree", "remove", "--force", path], { okCodes: [128, 1] });
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await runGit(repo, ["worktree", "prune"]);
}

export interface WorktreeEntry {
  readonly path: string;
  readonly branch?: string;
}

/** List the repo's worktrees (porcelain). */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const r = await runGit(repo, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (path !== undefined) entries.push({ path, ...(branch ? { branch } : {}) });
      path = line.slice("worktree ".length).trim();
      branch = undefined;
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.trim() === "" && path !== undefined) {
      entries.push({ path, ...(branch ? { branch } : {}) });
      path = undefined;
      branch = undefined;
    }
  }
  if (path !== undefined) entries.push({ path, ...(branch ? { branch } : {}) });
  return entries;
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await runGit(repo, ["branch", "-D", branch], { okCodes: [1] });
}

/** List local branch names under a prefix. */
export async function listBranches(repo: string, prefix: string): Promise<string[]> {
  const r = await runGit(repo, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`]);
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Stage everything and commit in a worktree. Returns false if there was nothing to commit. */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  await runGit(worktreePath, ["add", "-A"]);
  const status = await runGit(worktreePath, ["status", "--porcelain"]);
  if (status.stdout.trim().length === 0) return false;
  await runGit(worktreePath, ["commit", "--quiet", "-m", message]);
  return true;
}

/** The committed diff of `scratch` relative to `base` (for the judge / evaluation seam). */
export async function diffRange(repo: string, base: string, scratch: string): Promise<string> {
  const r = await runGit(repo, ["diff", `${base}..${scratch}`]);
  return r.stdout;
}

/**
 * The UNCOMMITTED working-tree diff of a worktree vs `baseRef`: tracked changes PLUS untracked
 * (non-ignored) files rendered as add-diffs. RETAINED failed work is uncommitted, so the committed
 * `base..scratch` range is empty for it — this surfaces what the build actually left on disk
 * (e.g. a file the builder wrote before timing out) so `ikbi diff <id>` is not a misleading
 * "no changes". Run with `cwd` = the worktree directory.
 */
export async function workingTreeDiff(worktreePath: string, baseRef: string): Promise<string> {
  const parts: string[] = [];
  const tracked = (await runGit(worktreePath, ["diff", baseRef])).stdout;
  if (tracked.trim().length > 0) parts.push(tracked.replace(/\n+$/, ""));
  const untracked = (await runGit(worktreePath, ["ls-files", "--others", "--exclude-standard"])).stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const rel of untracked) {
    // `git diff --no-index` exits 1 when the files differ (always, vs /dev/null) — that is the
    // success case here, so 1 is an ok code.
    const r = await runGit(worktreePath, ["diff", "--no-index", "--", "/dev/null", rel], { okCodes: [1] });
    if (r.stdout.trim().length > 0) parts.push(r.stdout.replace(/\n+$/, ""));
  }
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

export interface MergeComputation {
  readonly clean: boolean;
  /** The merged tree OID (when clean). */
  readonly tree?: string;
  /** Conflicted file paths (when not clean). */
  readonly conflicts: readonly string[];
}

/**
 * Compute a merge of `other` into `base` WITHOUT touching any worktree
 * (`git merge-tree --write-tree`). Clean => returns the merged tree OID; conflict
 * => returns the conflicted paths (and the target is left untouched).
 */
export async function computeMerge(repo: string, base: string, other: string): Promise<MergeComputation> {
  const r = await runGit(repo, ["merge-tree", "--write-tree", base, other], { okCodes: [1] });
  const lines = r.stdout.split("\n");
  if (r.code === 0) {
    return { clean: true, tree: (lines[0] ?? "").trim(), conflicts: [] };
  }
  // Conflict: the output includes conflicted file info; extract distinct paths best-effort.
  const conflicts = new Set<string>();
  for (const line of lines) {
    const m = /^\d{6} [0-9a-f]+ [123]\t(.+)$/.exec(line);
    if (m?.[1]) conflicts.add(m[1]);
  }
  return { clean: false, conflicts: [...conflicts] };
}

/** Create a merge commit object with the given tree + parents. Returns its OID. */
export async function commitTree(repo: string, tree: string, parents: readonly string[], message: string): Promise<string> {
  const args = ["commit-tree", tree];
  for (const p of parents) args.push("-p", p);
  args.push("-m", message);
  const r = await runGit(repo, args);
  return r.stdout.trim();
}

/**
 * Atomic compare-and-swap ref update: set `ref` to `newSha` only if it is
 * currently `oldSha`. This is the single target-mutating step of promote — it
 * lands fully or fails cleanly (and is safe against a concurrent target move).
 */
export async function updateRefCas(repo: string, ref: string, newSha: string, oldSha: string): Promise<void> {
  await runGit(repo, ["update-ref", ref, newSha, oldSha]);
}

/**
 * The path of the worktree currently checked out on `branch` (the main working tree
 * counts), or undefined if no worktree has that branch checked out (e.g. detached HEAD).
 * Used by promote to detect a working tree that the ref CAS would desync.
 */
export async function worktreeForBranch(repo: string, branch: string): Promise<string | undefined> {
  const match = (await listWorktrees(repo)).find((w) => w.branch === branch);
  return match?.path;
}

/** True iff the worktree at `worktreePath` has a clean working tree + index (porcelain empty). */
export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const r = await runGit(worktreePath, ["status", "--porcelain"]);
  return r.stdout.trim().length === 0;
}

/**
 * Hard-sync a worktree's index + working tree to `ref`. Called by promote AFTER the ref CAS,
 * only when that worktree was verified clean beforehand — so it brings the tree FORWARD to the
 * new HEAD (no user work to clobber) and `git status` is clean again (no phantom revert).
 *
 * M7 (TOCTOU): promote's earlier isWorktreeClean() gate and this destructive reset are NOT
 * atomic — a user can write new uncommitted work into the tree in the window between them, and
 * `reset --hard` would clobber it irrecoverably. So we re-check cleanliness immediately before
 * the reset and, if anything appeared, STASH it first (including untracked files). The stash is
 * preserved in the worktree's stash list — the late work is never lost, only set aside — and the
 * reset then proceeds against a clean tree. The operator recovers it with `git stash pop`.
 */
export async function syncWorktreeToRef(worktreePath: string, ref: string): Promise<void> {
  if (!(await isWorktreeClean(worktreePath))) {
    await runGit(worktreePath, [
      "stash",
      "push",
      "--include-untracked",
      "--quiet",
      "-m",
      `ikbi: auto-stashed late uncommitted work before promote-sync to ${ref}`,
    ]);
  }
  await runGit(worktreePath, ["reset", "--hard", "--quiet", ref]);
}
