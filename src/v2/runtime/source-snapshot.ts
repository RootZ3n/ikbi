/**
 * THE SOURCE SNAPSHOT AUTHORITY — git-backed capture, and reads bound to it.
 *
 * Git already knows which files are tracked, modified, deleted, untracked and ignored,
 * so this authority asks git rather than inventing a second opinion. It captures the
 * DELTA the operator currently sees on top of HEAD and nothing else: everything
 * unchanged is described by HEAD, which is immutable and therefore cannot drift.
 *
 * INDEX SEMANTICS, stated explicitly. `git status --porcelain` reports two columns —
 * index vs HEAD, and working tree vs index. This authority reads the WORKING TREE: what
 * the operator can actually see in their editor. A file that is `A` in HEAD, `B` staged
 * and `C` in the working tree is captured as `C`. The staging area is evidence about the
 * operator's intent, not a second source reality, and materializing `B` would reproduce a
 * state that exists nowhere on their screen.
 *
 * DRIFT is impossible by construction rather than by detection: every read resolves to
 * either captured delta bytes or `git show HEAD:<path>`. A source repository edited
 * mid-run cannot reach context or the workspace, and nothing is ever recaptured.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import { runGit } from "../../core/workspace/git.js";
import {
  DEFAULT_SOURCE_POLICY,
  V2_SOURCE_FAILURE_CODES,
  sourceFailure,
  sourceSnapshotDigest,
  type SourceCaptureResult,
  type SourceEntry,
  type SourceExclusion,
  type SourceReadOutcome,
  type SourceSnapshot,
  type SourceSnapshotAuthority,
  type SourceSnapshotPolicy,
  type SourceSnapshotReader,
} from "../core/source.js";

/** Per-file byte ceiling for a captured delta entry. A snapshot is source, not artifacts. */
export const MAX_CAPTURED_ENTRY_BYTES = 4 * 1024 * 1024;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Reject a path that is absolute or leaves the repository, before any I/O. */
function confined(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false;
  return !path.split(/[/\\]/).includes("..");
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * NUL-delimited because paths may contain anything; a rename record carries TWO
 * NUL-separated fields, so the parser consumes the extra one deliberately rather than
 * mistaking an old path for a new entry.
 */
export function parsePorcelain(raw: string): { path: string; index: string; worktree: string }[] {
  const out: { path: string; index: string; worktree: string }[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record === undefined || record.length < 4) continue;
    const index = record[0]!;
    const worktree = record[1]!;
    const path = record.slice(3);
    // A rename/copy record is followed by its ORIGINAL path in the next field.
    if (index === "R" || index === "C") i += 1;
    if (path.length > 0) out.push({ path, index, worktree });
  }
  return out;
}

/** Observe one working-tree path as a snapshot entry, or explain why it was excluded. */
function captureEntry(repoRoot: string, path: string, status: SourceEntry["status"]): { entry: SourceEntry } | { exclusion: SourceExclusion } {
  const full = join(repoRoot, ...path.split("/"));
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    // Reported as present by git but not readable now — a deletion in flight.
    return { entry: { path, status: "deleted", kind: "deleted", contentSha256: null, byteLength: null, executable: false, symlinkTarget: null } };
  }

  if (stat.isSymbolicLink()) {
    const target = readlinkSync(full);
    const bytes = Buffer.from(target, "utf8");
    return {
      entry: { path, status, kind: "symlink", contentSha256: sha256(bytes), byteLength: bytes.byteLength, executable: false, symlinkTarget: target },
    };
  }
  if (!stat.isFile()) return { exclusion: { path, reason: "unsupported_type" } };
  if (stat.size > MAX_CAPTURED_ENTRY_BYTES) return { exclusion: { path, reason: "unreadable" } };

  let bytes: Buffer;
  try {
    bytes = readFileSync(full);
  } catch {
    return { exclusion: { path, reason: "unreadable" } };
  }
  return {
    entry: {
      path,
      status,
      kind: bytes.byteLength === 0 ? "empty" : "regular",
      contentSha256: sha256(bytes),
      byteLength: bytes.byteLength,
      // Git tracks only the owner-execute bit, so that is the fact recorded.
      executable: (stat.mode & 0o100) !== 0,
      symlinkTarget: null,
    },
  };
}

/** The captured bytes for delta entries, held beside the snapshot rather than inside it. */
export type CapturedBytes = ReadonlyMap<string, Buffer>;

/** Build a reader over a snapshot and its captured delta bytes. */
export function createSnapshotReader(snapshot: SourceSnapshot, captured: CapturedBytes): SourceSnapshotReader {
  const entries = new Map(snapshot.entries.map((e) => [e.path, e]));
  return {
    snapshot,
    async read(path: string): Promise<SourceReadOutcome> {
      if (!confined(path)) return { ok: false, reason: "outside_repository", detail: `"${path}" is not a repository-relative path` };
      const normalized = path.split(sep).join("/");

      const entry = entries.get(normalized);
      if (entry !== undefined) {
        // THE DELTA: captured at snapshot time. Immune to anything the operator does now.
        if (entry.kind === "deleted") return { ok: false, reason: "missing", detail: "deleted in the captured source state" };
        if (entry.kind === "symlink") return { ok: false, reason: "not_a_regular_file", detail: "the captured source state has a symlink here" };
        const bytes = captured.get(normalized);
        if (bytes === undefined) return { ok: false, reason: "unreadable", detail: "captured entry has no retained bytes" };
        return { ok: true, content: bytes.toString("utf8"), byteLength: bytes.byteLength, contentSha256: entry.contentSha256 ?? sha256(bytes), origin: "snapshot_delta" };
      }

      // NOT IN THE DELTA: HEAD describes it, and a git blob cannot change under us.
      try {
        const result = await runGit(snapshot.repositoryRoot, ["show", `${snapshot.headCommit}:${normalized}`]);
        const bytes = Buffer.from(result.stdout, "utf8");
        return { ok: true, content: result.stdout, byteLength: bytes.byteLength, contentSha256: sha256(bytes), origin: "head_blob" };
      } catch {
        return { ok: false, reason: "missing", detail: "not present in the captured source state" };
      }
    },
  };
}

/**
 * THE capture. One call per run.
 *
 * Everything it needs comes from git: HEAD, the tree, and the porcelain status with
 * `--untracked-files=all` (so a new directory is enumerated file by file rather than as
 * one opaque entry). Ignored files are absent from that output, which is exactly the
 * exclusion policy — git's ignore rules are the operator's, already written down.
 */
export function createSourceSnapshotAuthority(deps: { readonly now?: () => number } = {}): SourceSnapshotAuthority & {
  capturedBytes(snapshotId: string): CapturedBytes | undefined;
} {
  const now = deps.now ?? Date.now;
  const byteStore = new Map<string, CapturedBytes>();

  return {
    capturedBytes: (snapshotId) => byteStore.get(snapshotId),

    async capture(input): Promise<SourceCaptureResult> {
      const policy: SourceSnapshotPolicy = input.policy ?? DEFAULT_SOURCE_POLICY;
      const repoPath = input.repoPath;

      let headCommit: string;
      let headTree: string;
      try {
        headCommit = (await runGit(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
        headTree = (await runGit(repoPath, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
      } catch (err) {
        return {
          ok: false,
          failure: sourceFailure({
            code: V2_SOURCE_FAILURE_CODES.notAGitRepository,
            message: `cannot read the source state of ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
            stage: "preflight",
            detail: { repoPath },
          }),
        };
      }

      let porcelain: string;
      try {
        porcelain = (await runGit(repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
      } catch (err) {
        return {
          ok: false,
          failure: sourceFailure({
            code: V2_SOURCE_FAILURE_CODES.captureFailed,
            message: `could not read the working-tree status of ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
            stage: "preflight",
            detail: { repoPath },
          }),
        };
      }

      const entries: SourceEntry[] = [];
      const exclusions: SourceExclusion[] = [];
      const captured = new Map<string, Buffer>();

      for (const record of parsePorcelain(porcelain)) {
        if (record.path.startsWith(".git/") || record.path === ".git") {
          exclusions.push({ path: record.path, reason: "git_internal" });
          continue;
        }
        const untracked = record.index === "?" && record.worktree === "?";
        // A deletion in EITHER column: staged-deleted or deleted in the working tree.
        // Both mean the operator does not currently see the file.
        const deleted = record.index === "D" || record.worktree === "D";

        if (untracked) {
          if (!policy.includeUntracked) {
            exclusions.push({ path: record.path, reason: "git_ignored" });
            continue;
          }
        } else if (deleted) {
          if (!policy.includeTrackedDeletions) continue;
          entries.push({ path: record.path, status: "deleted", kind: "deleted", contentSha256: null, byteLength: null, executable: false, symlinkTarget: null });
          continue;
        } else if (!policy.includeTrackedModifications) {
          continue;
        }

        const observed = captureEntry(repoPath, record.path, untracked ? "untracked" : "modified");
        if ("exclusion" in observed) {
          exclusions.push(observed.exclusion);
          continue;
        }
        entries.push(observed.entry);
        if (observed.entry.kind === "regular" || observed.entry.kind === "empty") {
          captured.set(observed.entry.path, readFileSync(join(repoPath, ...observed.entry.path.split("/"))));
        }
      }

      entries.sort((a, b) => a.path.localeCompare(b.path));
      exclusions.sort((a, b) => a.path.localeCompare(b.path));

      const snapshotId = sourceSnapshotDigest({ headCommit, headTree, entries, policy });
      const snapshot: SourceSnapshot = Object.freeze({
        snapshotId,
        repositoryRoot: repoPath,
        headCommit,
        headTree,
        clean: entries.length === 0,
        policy,
        entries: Object.freeze(entries),
        exclusions: Object.freeze(exclusions),
        counts: Object.freeze({
          modified: entries.filter((e) => e.status === "modified").length,
          deleted: entries.filter((e) => e.status === "deleted").length,
          untrackedIncluded: entries.filter((e) => e.status === "untracked").length,
          excluded: exclusions.length,
        }),
        capturedAt: now(),
      });

      byteStore.set(snapshotId, captured);
      return { ok: true, reader: createSnapshotReader(snapshot, captured) };
    },
  };
}
