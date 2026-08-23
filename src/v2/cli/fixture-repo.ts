/**
 * A real, tiny git repository for tests (NOT a test file).
 *
 * V2-006 allocates a real git worktree on the canonical path, so a fixture repository
 * has to be a real repository — a hand-made `.git` directory is not one, and using the
 * ikbi checkout itself would make every subprocess test pay for a full worktree checkout.
 *
 * Small, committed, and disposable: `git worktree add` from it is near-instant.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { dirname, join } from "node:path";

/** Run git in `cwd`, failing loudly — a broken fixture must not look like a broken feature. */
function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ikbi v2 fixture",
      GIT_AUTHOR_EMAIL: "fixture@ikbi.local",
      GIT_COMMITTER_NAME: "ikbi v2 fixture",
      GIT_COMMITTER_EMAIL: "fixture@ikbi.local",
      // PINNED DATES. Without these, two fixtures created either side of a second
      // boundary get different commit SHAs for identical content — which makes any test
      // comparing two repositories' source identity fail intermittently, and only under
      // load. A fixture's timestamps are not what any test is about.
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  });
}

/**
 * Create a repository containing `files`, committed on `main`.
 *
 * Everything is COMMITTED, so a worktree cut from HEAD holds byte-identical content —
 * which is what lets the canonical path re-observe a context artifact and find it
 * unchanged. An uncommitted file would (correctly) be seen as drift.
 */
export function initGitRepo(files: Readonly<Record<string, string>> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-v2-gitfixture-"));
  git(repo, ["init", "-b", "main", "--quiet"]);
  git(repo, ["config", "user.email", "fixture@ikbi.local"]);
  git(repo, ["config", "user.name", "ikbi v2 fixture"]);
  writeFiles(repo, { "README.md": "fixture\n", ...files });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
  return repo;
}

/** Write files into an existing repository WITHOUT committing them. */
export function writeFiles(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Write files and commit them, so a worktree cut from HEAD sees them. */
export function commitFiles(repo: string, files: Readonly<Record<string, string>>, message = "update"): void {
  writeFiles(repo, files);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", message]);
}

/** The current HEAD commit, for asserting a workspace's source binding. */
export function headCommit(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

/** The tree of the current HEAD, for asserting a workspace's source binding. */
export function headTree(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo, encoding: "utf8" }).trim();
}
