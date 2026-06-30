/**
 * ikbi worker-model — applyConsultPatch: the APPLIED frontier-consult build step.
 *
 * The recovery loop's frontier executor. When the worker+mid pool is exhausted AND frontier is
 * authorized, this runs a CONSULT in patch mode — ONE bounded, tool-free frontier call over an
 * evidence-dense packet — and applies the returned unified diff in the managed worktree using
 * the SAME confine + parse + apply primitives patchsmith uses. The frontier model never scans
 * the repo and never enters a tool loop; it returns a diff, ikbi applies it.
 *
 * It does NOT verify — the caller (orchestrator) runs the verification ladder on the worktree
 * afterward, exactly as for any build. The diff is worktree-local and promotion stays gated, so
 * a bad frontier patch fails closed at the ladder like any other.
 *
 * Lives in worker-model (not consult) by design: consult is the lower-level packet/call layer;
 * the APPLY step belongs with the build machinery that owns the worktree + diff primitives.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { runConsult as defaultRunConsult } from "../consult/index.js";
import type { ConsultRequest, ConsultResult } from "../consult/index.js";
import { confinePath } from "./builder-tools/confine.js";
import { applyFilePatch, extractDiff, parseUnifiedDiff } from "./patchsmith.js";

export type ApplyConsultStop = "no_diff" | "need_context" | "malformed_patch" | "path_violation" | "patch_did_not_apply";

export interface ApplyConsultPatchInput {
  /** The managed worktree the diff is applied into. */
  readonly workspacePath: string;
  /** Consult request fields (mode + repoRoot are set internally to "patch" + the worktree). */
  readonly request: Omit<ConsultRequest, "mode" | "repoRoot">;
}

export interface ApplyConsultPatchResult {
  /** True when the frontier diff parsed and applied cleanly into the worktree. */
  readonly applied: boolean;
  readonly filesChanged: readonly string[];
  readonly modelId?: string;
  readonly stopReason?: ApplyConsultStop;
  readonly error?: string;
  /** The underlying consult result (model, usage, cost, packet, answer). */
  readonly consult?: ConsultResult;
}

export interface ApplyConsultPatchDeps {
  readonly runConsult?: (req: ConsultRequest) => Promise<ConsultResult>;
}

export async function applyConsultPatch(
  input: ApplyConsultPatchInput,
  deps: ApplyConsultPatchDeps = {},
): Promise<ApplyConsultPatchResult> {
  const runConsult = deps.runConsult ?? defaultRunConsult;
  const worktreeReal = realpathSync(input.workspacePath);

  const result = await runConsult({ ...input.request, repoRoot: worktreeReal, mode: "patch" });
  const base = { modelId: result.modelId, consult: result } as const;

  const extracted = extractDiff(result.answer);
  if (extracted.kind === "need_context") {
    return { applied: false, filesChanged: [], stopReason: "need_context", error: `frontier needs context: ${extracted.files.join(", ")}`, ...base };
  }
  if (extracted.kind === "malformed") {
    return { applied: false, filesChanged: [], stopReason: "no_diff", error: extracted.reason, ...base };
  }

  const parsed = parseUnifiedDiff(extracted.text);
  if (!parsed.ok) {
    return { applied: false, filesChanged: [], stopReason: "malformed_patch", error: parsed.error, ...base };
  }

  // Confine EVERY touched path before writing a single byte (reject the patch whole).
  const plans: Array<{ deleted: boolean; rel: string; full: string; exists: boolean; patch: (typeof parsed.files)[number] }> = [];
  for (const fp of parsed.files) {
    const c = confinePath(worktreeReal, fp.path);
    if (!c.ok) {
      return { applied: false, filesChanged: [], stopReason: "path_violation", error: c.error, ...base };
    }
    plans.push({ deleted: fp.deleted, rel: c.rel, full: c.full, exists: existsSync(c.full), patch: fp });
  }

  // Compute new contents first (fail closed if any hunk misses), then write.
  const writes: Array<{ full: string; rel: string; content: string | null }> = [];
  for (const p of plans) {
    if (p.deleted) {
      writes.push({ full: p.full, rel: p.rel, content: null });
      continue;
    }
    const original = p.exists ? readFileSync(p.full, "utf8") : "";
    const applied = applyFilePatch(original, p.patch);
    if (!applied.ok) {
      return { applied: false, filesChanged: [], stopReason: "patch_did_not_apply", error: applied.error, ...base };
    }
    writes.push({ full: p.full, rel: p.rel, content: applied.content });
  }

  const filesChanged: string[] = [];
  for (const w of writes) {
    if (w.content === null) {
      if (existsSync(w.full)) rmSync(w.full);
    } else {
      mkdirSync(dirname(w.full), { recursive: true });
      writeFileSync(w.full, w.content);
    }
    filesChanged.push(w.rel);
  }

  return { applied: true, filesChanged, ...base };
}
