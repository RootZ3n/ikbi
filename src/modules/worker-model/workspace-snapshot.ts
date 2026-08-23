/**
 * ikbi worker-model — PHYSICAL FROZEN VERIFICATION SNAPSHOT (Phase 13C).
 *
 * Phase 13B bound promotion to a LOGICAL snapshot digest (the git tree hash) + the stale-tree/CAS. Phase 13C
 * adds a PHYSICALLY ISOLATED subject: a detached git worktree pinned to the candidate's committed tree, made
 * read-only and verified. A source-workspace mutation after freeze cannot change it (it is a separate checkout
 * of an immutable, content-addressed commit), and promotion can confirm the promoted content equals exactly
 * the frozen tree the snapshot resolves to.
 *
 * SCOPE: git-backed candidates only (a proven-non-git in-memory/test workspace keeps the Phase 13B logical
 * binding). The git object store is content-addressed, so the detached worktree's tree hash IS the canonical
 * digest; read-only permissions + a write probe prove the working files cannot be mutated in place. FAIL-CLOSED:
 * if the isolated tree cannot be created, its identity cannot be verified, or read-only cannot be established,
 * no physical snapshot is produced and the caller must not treat the mutable source as a frozen subject.
 */

import { chmodSync, mkdtempSync, openSync, closeSync, constants, readdirSync, statSync, lstatSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { runGit, removeWorktree } from "../../core/workspace/git.js";

export interface PhysicalSnapshot {
  readonly snapshotPath: string;
  /** The committed content tree the snapshot resolves to (content-addressed; the canonical digest). */
  readonly gitTree: string;
  readonly gitCommit: string;
  readonly canonicalDigest: string;
  /** True once read-only enforcement + a write probe confirmed the working files cannot be mutated in place. */
  readonly immutable: boolean;
  readonly createdAt: number;
  /** Remove the isolated worktree (safe on read-only files: restores write perms first). Idempotent. */
  cleanup(): Promise<void>;
}

/** Recursively make every working file/dir read-only (skips the `.git` pointer). */
function enforceReadOnly(root: string): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(full); chmodSync(full, 0o555); }
      else chmodSync(full, 0o444);
    }
  };
  walk(root);
}

/** Restore write permissions so the worktree can be removed. */
function restoreWritable(root: string): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { try { chmodSync(full, 0o755); } catch { /* best effort */ } walk(full); }
      else { try { chmodSync(full, 0o644); } catch { /* best effort */ } }
    }
  };
  try { walk(root); } catch { /* best effort */ }
}

/** Find one working file (not under .git) to probe read-only enforcement against. */
function firstWorkingFile(root: string): string | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name === ".git") continue;
      const full = join(dir, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) return full;
    }
  }
  return undefined;
}

/**
 * Create a physically isolated, read-only snapshot of `sourceWorktreePath`'s committed HEAD tree. Returns
 * undefined when the source is not a resolvable git worktree (the caller keeps the logical binding). Throws a
 * fail-closed error if a git-backed snapshot is attempted but its identity/immutability cannot be established.
 */
export async function createPhysicalSnapshot(sourceWorktreePath: string, expectedTree?: string, now: () => number = () => Date.now()): Promise<PhysicalSnapshot | undefined> {
  // Resolve the committed subject. A non-git / no-commit source ⇒ no physical snapshot (caller stays logical).
  const head = await runGit(sourceWorktreePath, ["rev-parse", "HEAD"], { okCodes: [128] }).catch(() => undefined);
  if (head === undefined || head.code !== 0) return undefined;
  const gitCommit = head.stdout.trim();
  const treeRes = await runGit(sourceWorktreePath, ["rev-parse", "HEAD^{tree}"], { okCodes: [128] }).catch(() => undefined);
  if (treeRes === undefined || treeRes.code !== 0) return undefined;
  const gitTree = treeRes.stdout.trim();
  if (expectedTree !== undefined && gitTree !== expectedTree) {
    throw new Error(`physical-snapshot: source committed tree ${gitTree} ≠ expected verified tree ${expectedTree} — refusing to freeze a subject that is not the verified one`);
  }

  const snapshotPath = mkdtempSync(join(tmpdir(), "ikbi-snap-"));
  let created = false;
  try {
    // Physically isolated: a DETACHED worktree pinned to the exact committed COMMIT (its tree is content-addressed).
    await runGit(sourceWorktreePath, ["worktree", "add", "--detach", "--quiet", snapshotPath, gitCommit]);
    created = true;
    // IDENTITY: the isolated checkout must resolve to exactly the expected tree.
    const snapTree = (await runGit(snapshotPath, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    if (snapTree !== gitTree) throw new Error(`physical-snapshot: isolated tree ${snapTree} ≠ source tree ${gitTree}`);
    // IMMUTABILITY: enforce read-only, then PROVE it by probing a write (must fail).
    enforceReadOnly(snapshotPath);
    const probe = firstWorkingFile(snapshotPath);
    let immutable = true;
    if (probe !== undefined) {
      let fd: number | undefined;
      try { fd = openSync(probe, constants.O_WRONLY); immutable = false; } // opened writable ⇒ NOT immutable
      catch { immutable = true; }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    if (!immutable) throw new Error("physical-snapshot: read-only enforcement failed — the snapshot is still writable (fail-closed)");
    const cleanup = async (): Promise<void> => { restoreWritable(snapshotPath); await removeWorktree(sourceWorktreePath, snapshotPath).catch(() => {}); };
    return { snapshotPath, gitTree, gitCommit, canonicalDigest: gitTree, immutable, createdAt: now(), cleanup };
  } catch (err) {
    // FAIL-CLOSED: tear down a partial worktree and propagate — a git-backed subject that cannot be frozen
    // physically must not silently degrade to promoting the mutable source.
    if (created) { restoreWritable(snapshotPath); await removeWorktree(sourceWorktreePath, snapshotPath).catch(() => {}); }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Verify a physical snapshot still resolves to its recorded tree (unchanged before/after an evidence stage). */
export async function verifySnapshotUnchanged(snapshot: Pick<PhysicalSnapshot, "snapshotPath" | "gitTree">): Promise<boolean> {
  const r = await runGit(snapshot.snapshotPath, ["rev-parse", "HEAD^{tree}"], { okCodes: [128] }).catch(() => undefined);
  if (r === undefined || r.code !== 0) return false;
  if (r.stdout.trim() !== snapshot.gitTree) return false;
  // Also confirm the working files are still read-only (a probe write must still fail).
  const probe = firstWorkingFile(snapshot.snapshotPath);
  if (probe !== undefined) {
    let fd: number | undefined;
    try { fd = openSync(probe, constants.O_WRONLY); return false; } catch { /* still read-only */ } finally { if (fd !== undefined) closeSync(fd); }
  }
  return true;
}

/** Best-effort assertion that a path resolves to a plain directory (used by callers before trusting it). */
export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
