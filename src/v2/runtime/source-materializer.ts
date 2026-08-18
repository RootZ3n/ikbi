/**
 * THE SOURCE MATERIALIZER — reproducing the captured source state inside a workspace.
 *
 * A fresh worktree is checked out at HEAD, which matches the snapshot exactly when the
 * operator's checkout is clean. When it is not, this applies the snapshot's DELTA so the
 * candidate workspace starts from what the operator actually sees: modified files written,
 * deleted files removed, untracked files created.
 *
 * WHY THIS IS ALLOWED TO WRITE, AND WHY THAT IS NOT A LOOPHOLE.
 *
 * This constructs a workspace's INITIAL state; it does not edit an existing candidate.
 * The distinction is the whole point of the file existing separately:
 *
 *   MATERIALIZATION   reproduces work the operator already did, from a snapshot captured
 *                     before anything ran. It is bounded by the snapshot, happens once,
 *                     is verified against the snapshot afterwards, and is NEVER counted
 *                     as a mutation.
 *   MUTATION          changes a workspace after it exists, always against an observation,
 *                     always compare-and-swapped. That is `mutate`, and it is the only
 *                     way anything downstream may write.
 *
 * A future builder must never import this module — a static guard enforces that. If it
 * could, "set up the starting state" would become a general write API, which is exactly
 * the escape hatch the state-bound design exists to remove.
 *
 * It writes only into the workspace. The source repository is read at capture time and
 * never touched here at all.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

import { contentDigest } from "../core/identity.js";
import {
  V2_SOURCE_FAILURE_CODES,
  sourceFailure,
  type SourceEntry,
  type SourceSnapshot,
} from "../core/source.js";
import type { RunFailure } from "../core/failure.js";
import type { CapturedBytes } from "./source-snapshot.js";

/** Proof that a workspace really holds the snapshot's state. */
export interface MaterializationProof {
  readonly snapshotId: string;
  /** Digest over what was actually found on disk after materialization, per delta path. */
  readonly materializedStateDigest: string;
  /** Delta entries applied. Zero for a clean snapshot — the worktree already matched. */
  readonly applied: number;
}

export type MaterializationResult =
  | { readonly ok: true; readonly proof: MaterializationProof }
  | { readonly ok: false; readonly failure: RunFailure };

/** Resolve a snapshot path inside the workspace, refusing anything that could escape. */
function resolveInside(workspacePath: string, path: string): string | undefined {
  if (path.length === 0 || isAbsolute(path) || path.split(/[/\\]/).includes("..")) return undefined;
  return join(workspacePath, ...path.split("/"));
}

/** Observe one delta path as it now exists in the workspace. */
function verifyEntry(workspacePath: string, entry: SourceEntry): { kind: string; contentSha256: string | null; symlinkTarget: string | null } {
  const full = resolveInside(workspacePath, entry.path);
  if (full === undefined) return { kind: "unresolvable", contentSha256: null, symlinkTarget: null };
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return { kind: "deleted", contentSha256: null, symlinkTarget: null };
  }
  if (stat.isSymbolicLink()) {
    const target = readFileSync(full, "utf8");
    return { kind: "symlink", contentSha256: null, symlinkTarget: target };
  }
  if (!stat.isFile()) return { kind: "other", contentSha256: null, symlinkTarget: null };
  const bytes = readFileSync(full);
  return {
    kind: bytes.byteLength === 0 ? "empty" : "regular",
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    symlinkTarget: null,
  };
}

/**
 * Apply the snapshot's delta to a freshly-created workspace, then VERIFY it.
 *
 * Verification is not optional: writes completing is not evidence that the workspace
 * matches the snapshot. Every delta path is re-read and compared, and a workspace that
 * fails the comparison is refused rather than handed on.
 */
export function materializeSnapshot(input: {
  readonly snapshot: SourceSnapshot;
  readonly captured: CapturedBytes;
  readonly workspacePath: string;
}): MaterializationResult {
  const { snapshot, captured, workspacePath } = input;
  let applied = 0;

  for (const entry of snapshot.entries) {
    const full = resolveInside(workspacePath, entry.path);
    if (full === undefined) {
      return {
        ok: false,
        failure: sourceFailure({
          code: V2_SOURCE_FAILURE_CODES.materializationFailed,
          message: `refusing to materialize "${entry.path}": it does not resolve inside the workspace`,
          stage: "candidate_strategy",
          detail: { path: entry.path },
        }),
      };
    }
    try {
      if (entry.kind === "deleted") {
        rmSync(full, { force: true });
      } else if (entry.kind === "symlink") {
        rmSync(full, { force: true });
        mkdirSync(dirname(full), { recursive: true });
        symlinkSync(entry.symlinkTarget ?? "", full);
      } else {
        const bytes = captured.get(entry.path);
        if (bytes === undefined) {
          return {
            ok: false,
            failure: sourceFailure({
              code: V2_SOURCE_FAILURE_CODES.materializationFailed,
              message: `the snapshot has no captured bytes for "${entry.path}"`,
              stage: "candidate_strategy",
              detail: { path: entry.path, snapshotId: snapshot.snapshotId },
            }),
          };
        }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, bytes, entry.executable ? { mode: 0o755 } : undefined);
      }
      applied += 1;
    } catch (err) {
      return {
        ok: false,
        failure: sourceFailure({
          code: V2_SOURCE_FAILURE_CODES.materializationFailed,
          message: `could not materialize "${entry.path}": ${err instanceof Error ? err.message : String(err)}`,
          stage: "candidate_strategy",
          detail: { path: entry.path, snapshotId: snapshot.snapshotId },
        }),
      };
    }
  }

  // VERIFY. Read back every delta path and compare it to what the snapshot recorded.
  const observed: { path: string; kind: string; contentSha256: string | null }[] = [];
  for (const entry of snapshot.entries) {
    const actual = verifyEntry(workspacePath, entry);
    observed.push({ path: entry.path, kind: actual.kind, contentSha256: actual.contentSha256 });
    const expectedKind = entry.kind;
    const matches =
      expectedKind === "deleted"
        ? actual.kind === "deleted"
        : expectedKind === "symlink"
          ? actual.kind === "symlink"
          : actual.kind === expectedKind && actual.contentSha256 === entry.contentSha256;
    if (!matches) {
      return {
        ok: false,
        failure: sourceFailure({
          code: V2_SOURCE_FAILURE_CODES.materializationMismatch,
          message: `the workspace does not match the captured source state at "${entry.path}" — it was not made usable`,
          stage: "candidate_strategy",
          detail: {
            path: entry.path,
            snapshotId: snapshot.snapshotId,
            expectedKind,
            expectedSha256: entry.contentSha256 ?? "none",
            actualKind: actual.kind,
            actualSha256: actual.contentSha256 ?? "none",
          },
        }),
      };
    }
  }

  return {
    ok: true,
    proof: Object.freeze({
      snapshotId: snapshot.snapshotId,
      materializedStateDigest: contentDigest("snapshot", { snapshotId: snapshot.snapshotId, observed }),
      applied,
    }),
  };
}

/** Re-exported for the workspace authority's own signature. */
export type { SourceSnapshot };
export const MATERIALIZER_PATH_SEPARATOR = sep;
