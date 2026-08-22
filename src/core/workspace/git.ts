/**
 * ikbi workspace primitive — git worktree mechanics.
 *
 * Thin, safe wrapper over the `git` CLI (array args via execFile — no shell, no
 * injection). Worktrees give isolation; the promote path computes the merge
 * OFF-worktree (`merge-tree --write-tree` + `commit-tree`) and lands it via a
 * single compare-and-swap `update-ref`, so the target is never half-merged.
 */

import { execFile } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { WorkspaceError } from "./contract.js";

const exec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Run a git command in `cwd`. Throws WorkspaceError("git") on non-zero unless the code is in `okCodes`.
 *
 * `env` is ADDITIVE (v2-007) and merges over `process.env`. It exists because a couple of
 * git facilities are configurable only by environment — `GIT_INDEX_FILE` above all, which
 * is the sanctioned way to stage into a throwaway index instead of the operator's. Callers
 * that omit it get exactly the previous behavior.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  opts?: { okCodes?: readonly number[]; env?: Readonly<Record<string, string>> },
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", args as string[], {
      cwd,
      maxBuffer: MAX_BUFFER,
      ...(opts?.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    });
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
  const symbolic = await runGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [1] });
  if (symbolic.code === 0) return symbolic.stdout.trim();

  const abbreviated = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { okCodes: [128] }).catch(() => undefined);
  const head = abbreviated?.stdout.trim();
  if (head === "HEAD" || symbolic.code === 1) {
    throw new WorkspaceError(
      "config",
      "target repository is in detached HEAD; pass an explicit baseBranch so workspace promotion has a real target branch",
    );
  }
  throw new WorkspaceError("config", "could not resolve the target repository's current branch; pass an explicit baseBranch");
}

export async function revParse(repo: string, ref: string): Promise<string> {
  const r = await runGit(repo, ["rev-parse", ref]);
  return r.stdout.trim();
}

/**
 * The CANONICAL identity of a git repository: the absolute path of its common git directory
 * (`git rev-parse --git-common-dir`, resolved to an absolute path). This is stable across a
 * repository's linked worktrees (they share one common dir) and independent of which lexical
 * path alias was used to reach it, while remaining DISTINCT for two different repositories.
 *
 * Additive and read-only — it changes no v1 behaviour. Used by v2 promotion to bind a target's
 * repository identity so the same candidate published to repo A/main and repo B/main cannot
 * share a promotion identity, and to detect a target path swapped under a symlink.
 */
export async function gitCommonDir(repo: string): Promise<string> {
  const r = await runGit(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
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
  /**
   * The commit the registration reports as this worktree's HEAD. Present for a normal
   * registration; absent for a bare repo entry.
   */
  readonly head?: string;
  /**
   * Set when git reports the worktree LOCKED, to the lock reason (empty string when the
   * operator gave none). A locked worktree is one somebody deliberately protected — a removable
   * medium, a long-running investigation — and automatic cleanup must never touch it.
   */
  readonly locked?: string;
  /**
   * Set when git itself judges the ADMINISTRATIVE ENTRY prunable, to git's own stated reason
   * (typically "gitdir file points to non-existent location"). This is git's verdict, not ours:
   * it means the registration can be dropped, and says nothing about the BRANCH, which is a
   * separate ref that survives pruning and may still hold unique commits.
   */
  readonly prunable?: string;
}

/**
 * List the repo's worktrees (porcelain).
 *
 * `locked` and `prunable` are parsed because cleanup has to distinguish three states a bare
 * path/branch pair cannot express: a live worktree, an administrative entry whose directory is
 * gone (git says `prunable`), and one an operator deliberately locked. Without them the only
 * available signal is "does the directory exist", which cannot tell a deliberately-locked
 * worktree on unmounted media apart from an abandoned one.
 */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const r = await runGit(repo, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let head: string | undefined;
  let locked: string | undefined;
  let prunable: string | undefined;
  const flush = (): void => {
    if (path === undefined) return;
    entries.push({
      path,
      ...(branch !== undefined ? { branch } : {}),
      ...(head !== undefined ? { head } : {}),
      ...(locked !== undefined ? { locked } : {}),
      ...(prunable !== undefined ? { prunable } : {}),
    });
    path = undefined;
    branch = undefined;
    head = undefined;
    locked = undefined;
    prunable = undefined;
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.startsWith("HEAD ")) {
      head = line.slice("HEAD ".length).trim();
    } else if (line === "locked" || line.startsWith("locked ")) {
      // `locked` alone means locked with no reason given; `locked <reason>` carries one.
      locked = line.length > "locked".length ? line.slice("locked ".length).trim() : "";
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      prunable = line.length > "prunable".length ? line.slice("prunable ".length).trim() : "";
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
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

/**
 * Universal build-OUTPUT dirs no repo wants committed. Every entry is a build artifact, never source
 * — so seeding these can only prevent junk, never hide the builder's work. Kept deliberately narrow
 * (no `dist/`/`build/`, which some repos DO track as source) so the seed is unambiguous.
 */
const DEFAULT_GITIGNORE = [
  "# seeded by ikbi — this greenfield build had no .gitignore; excludes build output only",
  "/target/", "target/",          // Rust / Maven / some JVM
  "node_modules/",                // Node
  "__pycache__/", "*.pyc", ".venv/", "*.egg-info/", // Python
  "*.class", "*.jar",             // JVM (javac output / packaged artifacts)
  "bin/", "obj/",                 // .NET (build output + NuGet restore intermediates)
  "build/", ".gradle/",           // Gradle (target/ above covers Maven)
  ".DS_Store",
  "",
].join("\n");

/**
 * If a worktree has NO `.gitignore`, seed a minimal one covering universal build-output dirs before
 * we stage. Without this, a greenfield build that runs a toolchain (e.g. `cargo test` → `target/`,
 * `npm i` → `node_modules/`) commits hundreds of artifact files on promote (the O3 papercut). NEVER
 * overwrites an existing `.gitignore` (respects the operator's), and is best-effort: any failure
 * leaves the original `git add -A` behavior untouched.
 */
async function seedDefaultGitignoreIfAbsent(worktreePath: string): Promise<void> {
  const gitignorePath = join(worktreePath, ".gitignore");
  try {
    await access(gitignorePath);
    return; // exists — leave it exactly as the operator/build left it
  } catch {
    // absent — fall through to seed
  }
  try {
    await writeFile(gitignorePath, DEFAULT_GITIGNORE, { flag: "wx" }); // wx: never clobber a race-created file
  } catch {
    // best-effort — a failure just means we stage as before
  }
}

/** True iff `path` begins with the ELF magic (\x7fELF) — a compiled binary (Go/C/Rust exe, .o, .so).
 *  Reads only the first 4 bytes; a shell script or any text file is never ELF, so this never misfires. */
function isElfBinary(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Un-stage newly-ADDED compiled binaries a build dropped in the worktree (e.g. `go build` → an
 * extensionless `./modulename`, or a C `a.out`). Directory-based ignores (target/, bin/, obj/) miss
 * these because they land at the root with no extension, so .gitignore can't catch them generically.
 * ELF magic is the reliable signal. `--diff-filter=A` scopes this to NEW files only, so a binary a repo
 * legitimately tracks (and the build merely rebuilt) is left staged.
 */
async function unstageAddedBinaries(worktreePath: string): Promise<void> {
  const added = (await runGit(worktreePath, ["diff", "--cached", "--name-only", "--diff-filter=A"])).stdout
    .split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const rel of added) {
    if (isElfBinary(join(worktreePath, rel))) await runGit(worktreePath, ["reset", "--quiet", "--", rel]);
  }
}

/** Stage everything and commit in a worktree. Returns false if there was nothing to commit. */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  // Detect changes BEFORE seeding, so a genuine no-op build lands nothing (and we never write a
  // spurious .gitignore into an otherwise-unchanged repo). `status --porcelain` sees untracked files
  // (e.g. `?? target/`) too, so this is a faithful "did the build change anything?" check.
  const pre = await runGit(worktreePath, ["status", "--porcelain"]);
  if (pre.stdout.trim().length === 0) return false;
  // There ARE changes ⇒ seed a default .gitignore (if absent) so build-output dirs (target/,
  // node_modules/, …) are excluded from the `add -A` below instead of committed as artifacts.
  await seedDefaultGitignoreIfAbsent(worktreePath);
  await runGit(worktreePath, ["add", "-A"]);
  // Drop extensionless compiled binaries that slipped past the dir-based ignores (e.g. a `go build` exe).
  await unstageAddedBinaries(worktreePath);
  // Re-check what's actually STAGED (a build whose only output was an unstaged binary lands nothing).
  const staged = await runGit(worktreePath, ["diff", "--cached", "--name-only"]);
  if (staged.stdout.trim().length === 0) return false;
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
export async function syncWorktreeToRef(worktreePath: string, ref: string): Promise<{ stashed: boolean }> {
  let stashed = false;
  if (!(await isWorktreeClean(worktreePath))) {
    await runGit(worktreePath, [
      "stash",
      "push",
      "--include-untracked",
      "--quiet",
      "-m",
      `ikbi: auto-stashed late uncommitted work before promote-sync to ${ref}`,
    ]);
    stashed = true;
  }
  await runGit(worktreePath, ["reset", "--hard", "--quiet", ref]);
  // Report whether a stash was created so the caller can LOUDLY tell the operator their working tree
  // was reset and their uncommitted work set aside (recover with `git stash pop`) — a crash-reconcile
  // that silently resets the user's checkout is a nasty surprise, even though nothing is lost.
  return { stashed };
}

/**
 * Synchronize a checked-out worktree's index + working tree to its OWN CURRENT HEAD, WITHOUT
 * EVER MOVING A REF (V2-019/HIGH-01).
 *
 * WHY THIS EXISTS SEPARATELY FROM `syncWorktreeToRef`. `git reset --hard <commit>` on a worktree
 * with a branch checked out does two things: it rewrites the index/working tree AND it moves that
 * branch to <commit>. After ikbi's ONE authorized publication CAS that second effect is a second
 * ref mutation, and it is a silent data-loss race:
 *
 *     base B → ikbi CAS lands I → another actor advances the branch I → C
 *              → ikbi syncs the worktree with `reset --hard I` → the branch moves BACKWARD C → I
 *
 * The concurrent publication C is overwritten by a step that was only ever supposed to touch the
 * working tree. So the post-CAS caller uses THIS helper instead: a bare `git reset --hard` (NO
 * commit argument) resets index + working tree to whatever HEAD currently is and leaves
 * `refs/heads/<branch>` exactly where it was — proven against real repositories, not assumed.
 *
 * The late-work guarantee is unchanged: if uncommitted work appeared in the TOCTOU window since
 * the caller's cleanliness check, it is STASHED (including untracked files) before the reset and
 * the stash fact is returned, so the operator can recover it with `git stash pop`.
 *
 * Returns the HEAD it actually synchronized to, so the caller can report the truth when that is
 * NOT the commit it published (another actor won the race) rather than forcing the tree back.
 */
export async function syncWorktreeToCurrentHead(worktreePath: string): Promise<{ stashed: boolean; head: string }> {
  let stashed = false;
  if (!(await isWorktreeClean(worktreePath))) {
    await runGit(worktreePath, [
      "stash",
      "push",
      "--include-untracked",
      "--quiet",
      "-m",
      "ikbi: auto-stashed late uncommitted work before promote-sync to the current HEAD",
    ]);
    stashed = true;
  }
  // NO commit argument, on purpose: this resets to HEAD and CANNOT move the checked-out branch.
  await runGit(worktreePath, ["reset", "--hard", "--quiet"]);
  const head = (await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  return { stashed, head };
}
