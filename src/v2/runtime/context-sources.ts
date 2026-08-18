/**
 * CONTEXT SOURCES — the read-only contributors.
 *
 * Each source finds candidates and hands them to the canonical assembler. None of them
 * decides what fits, what order things go in, or what reaches a builder. They read, they
 * hash exactly what they read, and they report what they could not read as an explicit
 * omission rather than staying quiet about it.
 *
 * WHAT V1 ACTUALLY GIVES A BUILDER — established by reading prompt construction, not
 * docs (`worker-model/builder.ts:1076-1094`). In order: the trusted system prompt with a
 * PRIMARY TARGETS addendum built from paths named in the goal
 * (`builder.ts:797-824`); then untrusted blocks for project instructions
 * (`loadProjectMemory`), a multi-step team hand-off, gbrain recall (OPT-IN, default
 * off), runtime-truth evidence, the goal, the success condition, and prior role results
 * (which carry the model-driven scout's brief).
 *
 * V2-004 therefore adopts the two DETERMINISTIC, model-free, production-reachable
 * contributors — repository instructions, and the files the goal names — and parks the
 * rest, each for a stated reason (see docs/V2-DONOR-CLASSIFICATION.md). Nothing here
 * invokes a model, spawns a process, or writes.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import type { ContextCandidate, ContextOmission, ContextSource, ContextSourceRequest, ContextSourceResult } from "../core/context.js";

/**
 * Per-file byte cap, adopted from v1's `MAX_PROJECT_INSTRUCTION_BYTES`
 * (`worker-model/project-memory.ts:32`): one large file must not crowd out the working
 * context. Truncation here is SOURCE-level and is recorded on the artifact; the
 * assembler's separate budget decisions are recorded as omissions.
 */
export const MAX_ARTIFACT_BYTES = 16_000;

/** The marker v1 appends when it truncates. Kept identical so prompts read the same. */
const TRUNCATION_MARKER = "\n…(truncated)";

/**
 * Repository instruction files, in v1's priority order
 * (`worker-model/project-memory.ts:22-30`). The primary pair is first-present-wins; the
 * `.ikbi` set is additive. Names are a fixed allowlist, so no name can traverse.
 */
export const PRIMARY_INSTRUCTION_FILES: readonly string[] = ["CLAUDE.md", "AGENTS.md"];
export const ADDITIVE_INSTRUCTION_FILES: readonly string[] = ["IKBI.md", ".ikbi/project.md", ".ikbi/checks.yaml", ".ikbi/ignore"];

/** Extensions a goal-named path must carry to be treated as a target file. */
export const TARGET_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "yaml", "yml", "toml",
  "py", "rs", "go", "java", "rb", "sh", "css", "html", "sql", "txt",
]);

/** Upper bound on goal-named targets. Mirrors v1's cap — a goal naming 50 files is not a targeted edit. */
export const MAX_TARGET_FILES = 10;

/** The outcome of a bounded, confined read. */
type ReadOutcome =
  | { readonly ok: true; readonly content: string; readonly originalBytes: number; readonly truncated: boolean; readonly sha256: string }
  | { readonly ok: false; readonly reason: ContextOmission["reason"]; readonly detail: string };

/**
 * Read one repository-relative path, confined to the repository.
 *
 * POLICY, stated rather than implied:
 *   - an absolute path or one containing a `..` segment is refused before any I/O;
 *   - the resolved real path must remain inside the repository's real path, so a symlink
 *     that POINTS OUTSIDE is refused (a symlink that stays inside is followed and read,
 *     and is indistinguishable from the file it names — which is the intent);
 *   - anything that is not a regular file is refused rather than read;
 *   - a missing or unreadable file is represented truthfully, never silently skipped.
 *
 * The SHA-256 is of the exact bytes on disk, before truncation, so the artifact names the
 * real observed state even when the content it carries is bounded.
 */
export function readConfined(repoPath: string, relative: string): ReadOutcome {
  if (isAbsolute(relative)) return { ok: false, reason: "outside_repository", detail: `"${relative}" is an absolute path` };
  if (relative.split(/[/\\]/).includes("..")) return { ok: false, reason: "outside_repository", detail: `"${relative}" traverses outside the repository` };

  let repoReal: string;
  try {
    repoReal = realpathSync(repoPath);
  } catch {
    return { ok: false, reason: "unreadable", detail: `the repository path could not be resolved` };
  }

  const target = join(repoReal, relative);
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return { ok: false, reason: "not_found", detail: `no such file` };
  }

  if (stat.isSymbolicLink()) {
    let linkReal: string;
    try {
      linkReal = realpathSync(target);
    } catch {
      return { ok: false, reason: "not_found", detail: `symlink target does not exist` };
    }
    if (!linkReal.startsWith(repoReal + sep)) {
      return { ok: false, reason: "outside_repository", detail: `symlink escapes the repository` };
    }
    if (!lstatSync(linkReal).isFile()) return { ok: false, reason: "not_a_regular_file", detail: `symlink does not point at a regular file` };
  } else if (!stat.isFile()) {
    return { ok: false, reason: "not_a_regular_file", detail: `not a regular file` };
  }

  let raw: Buffer;
  try {
    raw = readFileSync(target);
  } catch (err) {
    return { ok: false, reason: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
  const text = raw.toString("utf8");
  if (text.trim().length === 0) return { ok: false, reason: "empty", detail: `the file is empty` };

  const truncated = raw.byteLength > MAX_ARTIFACT_BYTES;
  return {
    ok: true,
    content: truncated ? `${text.slice(0, MAX_ARTIFACT_BYTES)}${TRUNCATION_MARKER}` : text,
    originalBytes: raw.byteLength,
    truncated,
    // The digest is of the bytes AS OBSERVED — truncation bounds what is carried, not
    // what was seen, so the state binding stays exact.
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function candidateFrom(
  read: Extract<ReadOutcome, { ok: true }>,
  input: { category: ContextCandidate["category"]; sourceId: string; path: string; reason: string },
): ContextCandidate {
  return {
    category: input.category,
    sourceId: input.sourceId,
    path: input.path,
    origin: "repository",
    content: read.content,
    originalBytes: read.originalBytes,
    truncated: read.truncated,
    observedSha256: read.sha256,
    reason: input.reason,
  };
}

/**
 * REPOSITORY INSTRUCTIONS. Adopts v1's file set and first-present-wins rule for the
 * primary pair, then the additive `.ikbi` files — but emits ONE ARTIFACT PER FILE rather
 * than v1's single concatenated blob, so every file carries its own path and its own
 * observed digest.
 *
 * These files are INPUT DATA. They may guide a future builder; they can no more change
 * routing, mutation authority or promotion rules than any other repository content can.
 */
export const repositoryInstructionsSource: ContextSource = {
  id: "repository_instructions",
  async collect(request: ContextSourceRequest): Promise<ContextSourceResult> {
    const candidates: ContextCandidate[] = [];
    const omissions: ContextOmission[] = [];

    let primaryFound = false;
    for (const name of PRIMARY_INSTRUCTION_FILES) {
      if (primaryFound) break;
      const read = readConfined(request.repoPath, name);
      if (read.ok) {
        primaryFound = true;
        candidates.push(candidateFrom(read, { category: "repository_instructions", sourceId: "repository_instructions", path: name, reason: "the repository's primary instruction file" }));
      } else if (read.reason !== "not_found") {
        omissions.push({ category: "repository_instructions", sourceId: "repository_instructions", path: name, reason: read.reason, detail: read.detail });
      }
    }

    for (const name of ADDITIVE_INSTRUCTION_FILES) {
      const read = readConfined(request.repoPath, name);
      if (read.ok) {
        candidates.push(candidateFrom(read, { category: "repository_instructions", sourceId: "repository_instructions", path: name, reason: "an additive ikbi project instruction file" }));
      } else if (read.reason !== "not_found") {
        omissions.push({ category: "repository_instructions", sourceId: "repository_instructions", path: name, reason: read.reason, detail: read.detail });
      }
    }

    return { candidates, omissions };
  },
};

/**
 * Paths the goal names. Adopted from v1's `extractTargetFiles`
 * (`worker-model/builder.ts:797-813`): path-shaped tokens, no traversal, a known
 * extension, deduplicated, capped. Pure — it reads nothing.
 */
export function extractGoalTargets(goal: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // The leading `/` is INCLUDED in the match on purpose. v1's regex cannot capture it,
  // so `/etc/passwd.ts` reaches its filter as `etc/passwd.ts` and is treated as a
  // repository-relative target (harmless — the read is confined either way — but untrue).
  // v2 sees the slash and declines to call an absolute path a target at all.
  const pathLike = /\/?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,5}/g;
  for (const raw of goal.match(pathLike) ?? []) {
    const candidate = raw.replace(/^\.\//, "");
    if (candidate.includes("..") || candidate.startsWith("/")) continue;
    const ext = (candidate.split(".").pop() ?? "").toLowerCase();
    if (!TARGET_FILE_EXTENSIONS.has(ext)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= MAX_TARGET_FILES) break;
  }
  return out;
}

/**
 * TARGET FILES — the files the goal explicitly names, read and bound to their exact
 * content. v1 names these to the builder as PRIMARY TARGETS but does not read them; v2
 * includes the content AND its digest, so the package records the precise state the
 * builder was shown.
 *
 * A named file that does not exist is recorded as an omission, not dropped: "the goal
 * names a file this repository does not have" is information a builder needs.
 */
export const goalTargetFilesSource: ContextSource = {
  id: "goal_target_files",
  async collect(request: ContextSourceRequest): Promise<ContextSourceResult> {
    const candidates: ContextCandidate[] = [];
    const omissions: ContextOmission[] = [];
    for (const path of extractGoalTargets(request.goal)) {
      const read = readConfined(request.repoPath, path);
      if (read.ok) {
        candidates.push(candidateFrom(read, { category: "target_file", sourceId: "goal_target_files", path, reason: "the goal names this file" }));
      } else {
        omissions.push({ category: "target_file", sourceId: "goal_target_files", path, reason: read.reason, detail: read.detail });
      }
    }
    return { candidates, omissions };
  },
};

/** THE production source list, in consultation order. One list, one place. */
export const PRODUCTION_CONTEXT_SOURCES: readonly ContextSource[] = Object.freeze([
  repositoryInstructionsSource,
  goalTargetFilesSource,
]);
