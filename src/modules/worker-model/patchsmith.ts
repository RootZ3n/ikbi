/**
 * ikbi worker-model — THE PATCHSMITH BUILDER LANE.
 *
 * A second builder lane (decision #patchsmith) for models that FAIL the autonomous
 * tool-agent capability bar but can still produce a clean unified diff. Instead of a
 * tool-calling loop, the patchsmith:
 *
 *   1. gathers context (the goal, the target files, the failing-check output),
 *   2. sends ONE simple prompt to the model — NO tools, no shell, no wandering,
 *   3. parses the response as a unified diff (fenced-block + NEED_MORE_CONTEXT tolerant),
 *   4. validates every touched path (confinement + forbidden files + write scope),
 *   5. applies the diff in the managed worktree,
 *   6. runs the SAME governed ladder checks the verifier uses,
 *   7. on a red verdict, sends the failure output back for ONE repair attempt,
 *   8. fails CLOSED after the repair budget — a patch never promotes without a green verdict.
 *
 * It is a `RoleFn` like the agent builder: same `RoleContext`, returns a `role: "builder"`
 * `RoleResult`. The orchestrator's verifier role still runs downstream as the authoritative
 * gate — the patchsmith's in-lane verification only decides whether to REPAIR, never whether
 * to promote (that stays orchestrator-owned, freeze-critical). It NEVER throws past the role
 * boundary; an IO/model failure surfaces as a "failure" outcome.
 *
 * SECURITY: the goal + file bodies + check output are UNTRUSTED data — they ride into the
 * prompt through `ctx.engine.neutralizeUntrusted` (the #8 seam), never raw-concatenated into
 * the trusted system instruction. The model's diff is data too: every path is re-confined to
 * the worktree before a single byte is written, and a patch touching a forbidden/dependency
 * path is rejected WHOLE (no partial apply).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import type { OperationContext } from "../../core/identity/index.js";
import { toUntrustedMessage } from "../../core/injection/index.js";
import { childLogger } from "../../core/log.js";
import { adaptMaxTokens, getCapabilities } from "../../core/provider/capabilities.js";
import type { ModelMessage } from "../../core/provider/contract.js";
import { parseCheckOutput } from "../check-triage/index.js";
import type { GovernedExec } from "../governed-exec/index.js";
import { extractTargetFiles } from "./builder.js";
import { confinePath, type ToolCallError } from "./builder-tools/confine.js";
import { type CheckResult, type ChecksResolution, mapExec, resolveCheckTimeoutMs, VERIFIER_CHECKS } from "./checks.js";
import type { RoleFn, WorkerOutcome } from "./contract.js";
import { builderModel } from "./role-models.js";

const log = childLogger("worker-model:patchsmith");

/** Completion budget for a single patch (kept modest — a minimal diff is small). */
export const PATCHSMITH_MAX_TOKENS = 4_096;
/** Deterministic generation — a patch is a precise artifact, not a creative one. */
export const PATCHSMITH_TEMPERATURE = 0;
/** How many REPAIR attempts after the first patch fails verification. Spec: exactly ONE. */
export const PATCHSMITH_MAX_REPAIRS = 1;
/** Max bytes of any single file body sent into the prompt (bounds cheap-model context). */
const MAX_CONTEXT_BYTES = 24_000;
/** Build/dependency directories a patch may NEVER touch (mirrors write_file's guard). */
const BLOCKED_PATH_PREFIXES = ["node_modules/", ".git/", "dist/", ".next/", ".cache/"];
/** Tests are off-limits to the patchsmith unless the task explicitly allows it. */
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// ───────────────────────────────────────────────────────────────────────────
// Unified diff: parse + apply (self-contained — no shell-out, fully testable).
// ───────────────────────────────────────────────────────────────────────────

/** One line inside a hunk. */
interface DiffLine {
  readonly kind: "context" | "add" | "del";
  readonly text: string;
}
/** One @@ hunk. */
interface Hunk {
  readonly oldStart: number;
  /** Declared old-side line count from the header (context + deletions). */
  readonly oldCount: number;
  /** Declared new-side line count from the header (context + additions). */
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
}
/** A per-file patch parsed out of the unified diff. */
export interface FilePatch {
  /** Worktree-relative path the hunks apply to ("b/" side; "a/" side for a pure deletion). */
  readonly path: string;
  /** True when this patch CREATES a file (a/ side is /dev/null). */
  readonly created: boolean;
  /** True when this patch DELETES a file (b/ side is /dev/null). */
  readonly deleted: boolean;
  readonly hunks: readonly Hunk[];
}

/** Result of pulling a diff out of a raw model response. */
export type DiffExtraction =
  | { readonly kind: "diff"; readonly text: string }
  | { readonly kind: "need_context"; readonly files: readonly string[] }
  | { readonly kind: "malformed"; readonly reason: string };

/** Strip a leading `a/` or `b/` from a diff path; map /dev/null through unchanged. */
function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/**
 * Pull a unified diff out of a raw model response. Tolerant of the three shapes a cheap
 * model emits: a bare diff, a ```diff fenced block, or a NEED_MORE_CONTEXT escape hatch.
 */
export function extractDiff(raw: string): DiffExtraction {
  const text = raw ?? "";
  // 1. NEED_MORE_CONTEXT: the model's honest "I can't fix this with what I was given".
  const need = text.match(/NEED_MORE_CONTEXT:\s*([^\n]+)/);
  if (need !== undefined && need !== null) {
    const files = need[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { kind: "need_context", files };
  }
  // 2. A fenced block (```diff … ``` or a bare ``` … ```) — prefer one that looks like a diff.
  const fences = [...text.matchAll(/```(?:diff|patch)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const body of fences) {
    if (looksLikeDiff(body)) return { kind: "diff", text: body };
  }
  // 3. A bare diff in the response body.
  if (looksLikeDiff(text)) return { kind: "diff", text };
  return { kind: "malformed", reason: "response contained no unified diff (no ---/+++/@@ headers)" };
}

/** A cheap structural test: a unified diff has at least one @@ hunk header and a +++/--- pair. */
function looksLikeDiff(s: string): boolean {
  return /(^|\n)@@ /.test(s) && /(^|\n)\+\+\+ /.test(s) && /(^|\n)--- /.test(s);
}

/**
 * Parse a unified diff into per-file patches. Returns an error string on a structurally
 * broken diff (a hunk before any file header, an unparsable @@ line). Lenient about the
 * `diff --git`/`index`/`mode` noise git emits around the real hunks.
 */
export function parseUnifiedDiff(text: string): { ok: true; files: FilePatch[] } | { ok: false; error: string } {
  const rawLines = text.split("\n");
  const files: Array<{ path: string; created: boolean; deleted: boolean; hunks: Hunk[] }> = [];
  let cur: { path: string; created: boolean; deleted: boolean; hunks: Hunk[] } | undefined;
  let oldPath: string | undefined;
  // `oldConsumed`/`newConsumed` count lines seen so far against the header's declared counts —
  // the header is authoritative, so the diff's own trailing newline (a phantom "" line) is NOT
  // mistaken for a context line once both sides are satisfied.
  let hunk: { oldStart: number; oldCount: number; newCount: number; oldConsumed: number; newConsumed: number; lines: DiffLine[] } | undefined;

  const closeHunk = (): void => {
    if (hunk !== undefined && cur !== undefined) cur.hunks.push({ oldStart: hunk.oldStart, oldCount: hunk.oldCount, newCount: hunk.newCount, lines: hunk.lines });
    hunk = undefined;
  };
  const hunkComplete = (): boolean => hunk !== undefined && hunk.oldConsumed >= hunk.oldCount && hunk.newConsumed >= hunk.newCount;
  const closeFile = (): void => {
    closeHunk();
    if (cur !== undefined) files.push(cur);
    cur = undefined;
    oldPath = undefined;
  };

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]!;
    if (line.startsWith("--- ")) {
      closeFile();
      oldPath = stripPrefix(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = stripPrefix(line.slice(4).trim());
      const created = oldPath === "/dev/null";
      const deleted = newPath === "/dev/null";
      const path = deleted ? (oldPath ?? "") : newPath;
      if (path === "" || path === "/dev/null") return { ok: false, error: "diff has a file header with no usable path" };
      cur = { path, created, deleted, hunks: [] };
      continue;
    }
    if (line.startsWith("@@")) {
      if (cur === undefined) return { ok: false, error: "hunk (@@) appeared before any file header (---/+++)" };
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m === null) return { ok: false, error: `malformed hunk header: ${line.slice(0, 60)}` };
      closeHunk();
      // A count omitted in the header means 1 (unified-diff convention).
      hunk = { oldStart: Number.parseInt(m[1]!, 10), oldCount: m[2] !== undefined ? Number.parseInt(m[2], 10) : 1, newCount: m[4] !== undefined ? Number.parseInt(m[4], 10) : 1, oldConsumed: 0, newConsumed: 0, lines: [] };
      continue;
    }
    if (hunk !== undefined) {
      // Once the header's declared old+new line counts are satisfied, the hunk is done —
      // anything after (e.g. the diff's trailing "" or trailing prose) is NOT part of it.
      if (hunkComplete()) {
        closeHunk();
        continue;
      }
      // A "\ No newline at end of file" marker is metadata, not a body line.
      if (line.startsWith("\\")) continue;
      const tag = line[0];
      const body = line.slice(1);
      if (tag === "+") {
        hunk.lines.push({ kind: "add", text: body });
        hunk.newConsumed += 1;
      } else if (tag === "-") {
        hunk.lines.push({ kind: "del", text: body });
        hunk.oldConsumed += 1;
      } else if (tag === " " || line === "") {
        // A blank line inside a not-yet-complete hunk is a genuine empty context line.
        hunk.lines.push({ kind: "context", text: tag === " " ? body : "" });
        hunk.oldConsumed += 1;
        hunk.newConsumed += 1;
      } else {
        // Any other leading char ends the hunk's run of lines (e.g. a trailing prose line).
        closeHunk();
      }
    }
  }
  closeFile();

  if (files.length === 0) return { ok: false, error: "diff parsed to zero file patches" };
  for (const f of files) {
    if (!f.created && !f.deleted && f.hunks.length === 0) return { ok: false, error: `file ${f.path} has no hunks` };
  }
  return { ok: true, files };
}

/** The before/after line arrays a hunk represents (context shared by both sides). */
function hunkBeforeAfter(h: Hunk): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const l of h.lines) {
    if (l.kind === "context") {
      before.push(l.text);
      after.push(l.text);
    } else if (l.kind === "del") before.push(l.text);
    else after.push(l.text);
  }
  return { before, after };
}

/**
 * Apply one file's hunks to its current content (or "" for a new file). Locates each hunk's
 * BEFORE block (tolerating drifted line numbers by searching when the hinted position misses),
 * splices in the AFTER block, and fails CLOSED if any hunk does not match exactly.
 */
export function applyFilePatch(original: string, patch: FilePatch): { ok: true; content: string } | { ok: false; error: string } {
  if (patch.created) {
    // A creation is one hunk of pure additions — concatenate the added lines.
    const added: string[] = [];
    for (const h of patch.hunks) for (const l of h.lines) if (l.kind !== "del") added.push(l.text);
    return { ok: true, content: added.join("\n") + (added.length > 0 ? "\n" : "") };
  }
  const hadTrailingNewline = original.endsWith("\n");
  const fileLines = original.length === 0 ? [] : original.replace(/\n$/, "").split("\n");
  let searchFrom = 0;

  for (const h of patch.hunks) {
    const { before, after } = hunkBeforeAfter(h);
    const matchesAt = (pos: number): boolean => {
      if (pos < 0 || pos + before.length > fileLines.length) return false;
      for (let i = 0; i < before.length; i += 1) if (fileLines[pos + i] !== before[i]) return false;
      return true;
    };
    if (before.length === 0) {
      // Pure insertion — place at the hinted line (clamped), preferring not to rewind.
      const at = Math.max(searchFrom, Math.min(Math.max(h.oldStart - 1, 0), fileLines.length));
      fileLines.splice(at, 0, ...after);
      searchFrom = at + after.length;
      continue;
    }
    let pos = -1;
    const hint = Math.max(0, h.oldStart - 1);
    if (hint >= searchFrom && matchesAt(hint)) pos = hint;
    if (pos === -1) {
      for (let p = searchFrom; p <= fileLines.length - before.length; p += 1) {
        if (matchesAt(p)) {
          pos = p;
          break;
        }
      }
    }
    if (pos === -1) return { ok: false, error: `hunk does not apply to ${patch.path} (context not found near line ${h.oldStart})` };
    fileLines.splice(pos, before.length, ...after);
    searchFrom = pos + after.length;
  }

  const joined = fileLines.join("\n");
  return { ok: true, content: hadTrailingNewline || original.length === 0 ? joined + (joined.length > 0 ? "\n" : "") : joined };
}

// ───────────────────────────────────────────────────────────────────────────
// The patchsmith RoleFn.
// ───────────────────────────────────────────────────────────────────────────

/** Module-internal injection — mirrors BuilderDeps so the orchestrator wires it identically. */
export interface PatchsmithDeps {
  /** Governed executor — the in-lane verification runs through it (gate-wall + receipts). */
  readonly governedExec?: Pick<GovernedExec, "run">;
  /** The run's validated OperationContext (#10). Absent ⇒ verification cannot run (fail-closed). */
  readonly parentCtx?: OperationContext;
  /** Per-candidate model id (the head-to-head shootout). */
  readonly modelOverride?: string;
  /** Resolve the SAME check set + project-root guard the verifier uses. */
  readonly resolveChecks?: (worktreeReal: string) => ChecksResolution;
}

/** A forbidden-path reason, or undefined when the path is allowed. */
function patchPathViolation(rel: string, opts: { forbidden: readonly string[]; allowTests: boolean; writeScope: "all" | "new_only" | "none"; exists: boolean }): string | undefined {
  const norm = rel.replace(/\\/g, "/");
  if (BLOCKED_PATH_PREFIXES.some((bp) => norm.startsWith(bp) || norm.includes(`/${bp}`))) return `dependency/build directory is off-limits: ${rel}`;
  if (opts.writeScope === "none") return "task is read-only — no file may be written";
  if (opts.writeScope === "new_only" && opts.exists) return `write_scope is 'new_only' — cannot modify existing file: ${rel}`;
  for (const f of opts.forbidden) {
    const fn = f.replace(/\\/g, "/");
    if (norm === fn || norm.startsWith(fn.endsWith("/") ? fn : `${fn}/`)) return `forbidden file: ${rel}`;
  }
  if (!opts.allowTests && TEST_FILE_RE.test(norm)) return `test files are off-limits to the patchsmith (not told to modify tests): ${rel}`;
  return undefined;
}

/** Read the optional `forbiddenFiles` string[] off task metadata (never throws on a bad shape). */
function readForbiddenFiles(metadata: Readonly<Record<string, unknown>> | undefined): string[] {
  const v = metadata?.forbiddenFiles;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Read the optional `allowTestEdits` boolean off task metadata. */
function readAllowTestEdits(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  return metadata?.allowTestEdits === true;
}

/** Read optional extra `contextFiles` (string[]) the caller wants supplied to the model. */
function readContextFiles(metadata: Readonly<Record<string, unknown>> | undefined): string[] {
  const v = metadata?.contextFiles;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Map an in-lane stop reason to the role outcome (only a green verdict is "success"). */
function classify(stop: string): WorkerOutcome {
  if (stop === "verified") return "success";
  if (stop === "rejected_forbidden" || stop === "approval_required") return "rejected";
  return "failure";
}

/**
 * THE PATCHSMITH SYSTEM INSTRUCTION (trusted). Deliberately SIMPLE — cheap models choke on
 * elaborate rule lists. The task/files/output ride as a separate UNTRUSTED message.
 */
export const PATCHSMITH_SYSTEM =
  "You are a code fix generator. Given a failing check and the relevant source files, produce a " +
  "minimal unified diff that fixes the issue.\n\n" +
  "RULES:\n" +
  "- Return ONLY a unified diff: `--- a/path`, `+++ b/path`, then `@@ ... @@` hunks.\n" +
  "- Do NOT explain, do NOT add commentary, do NOT modify test files unless explicitly told to.\n" +
  "- Make the SMALLEST change that fixes the issue. Keep unrelated lines untouched.\n" +
  "- If you cannot fix it with the files given, reply with exactly: NEED_MORE_CONTEXT: path1, path2";

/** Build the UNTRUSTED context body (goal + files + check output + constraints). */
function buildContextBody(args: {
  goal: string;
  files: ReadonlyArray<{ path: string; body: string }>;
  checkOutput: string | undefined;
  forbidden: readonly string[];
}): string {
  const fileBlocks = args.files.length > 0 ? args.files.map((f) => `--- ${f.path} ---\n${f.body}`).join("\n\n") : "(no source files were located for the named targets)";
  const constraints = [`- Do NOT modify: ${[...args.forbidden, "tests (*.test.ts / *.spec.ts)"].join(", ")}`, "- Do NOT add new dependencies."].join("\n");
  return [
    `TASK: ${args.goal}`,
    "",
    "FAILING CHECK OUTPUT:",
    args.checkOutput !== undefined && args.checkOutput.length > 0 ? args.checkOutput : "(none provided — infer the fix from the task and files)",
    "",
    "RELEVANT FILES:",
    fileBlocks,
    "",
    "CONSTRAINTS:",
    constraints,
  ].join("\n");
}

/**
 * Build a patchsmith RoleFn. `deps` (governedExec + parentCtx + resolveChecks) are threaded
 * module-internally by the orchestrator's `builderFor`, exactly like the agent builder.
 */
export function createPatchsmith(deps: PatchsmithDeps = {}): RoleFn {
  return async (ctx) => {
    // Mirror the agent builder's approval gate: a tier that requiresApproval cannot write.
    if (ctx.autonomy.requiresApproval) {
      return {
        role: "builder",
        outcome: "rejected",
        summary: `approval required (tier "${ctx.autonomy.tier}") — patchsmith refusing to write`,
        detail: { builderMode: "patch", filesSupplied: [], filesChanged: [], patchAttempts: 0, repairAttempts: 0, verificationResult: "blocked", stopReason: "approval_required" },
      };
    }

    const modelId = deps.modelOverride ?? builderModel();
    const filesSupplied: string[] = [];
    const filesChanged = new Set<string>();
    const rejected: ToolCallError[] = [];
    let patchAttempts = 0;
    let repairAttempts = 0;
    let neutralizedCount = 0;
    let lastVerification: { allPass: boolean; output: string; ran: boolean } = { allPass: false, output: "", ran: false };
    let needContext: readonly string[] | undefined;
    let stopReason = "no_patch";

    try {
      const worktreeReal = realpathSync(ctx.workspace.path);
      const writeScope = ctx.task.writeScope ?? "all";
      const forbidden = readForbiddenFiles(ctx.task.metadata);
      const allowTests = readAllowTestEdits(ctx.task.metadata);
      const caps = getCapabilities(modelId);
      const effectiveMaxTokens = adaptMaxTokens(PATCHSMITH_MAX_TOKENS, caps);

      // ── gather context: the goal-named targets + any caller-supplied context files ──
      const targets = [...new Set([...extractTargetFiles(ctx.task.goal), ...readContextFiles(ctx.task.metadata)])];
      const contextFiles: Array<{ path: string; body: string }> = [];
      for (const t of targets) {
        const c = confinePath(worktreeReal, t);
        if (!c.ok || !existsSync(c.full)) continue;
        try {
          contextFiles.push({ path: c.rel, body: readFileSync(c.full, "utf8").slice(0, MAX_CONTEXT_BYTES) });
          filesSupplied.push(c.rel);
        } catch {
          /* unreadable file — skip; the model gets the rest */
        }
      }

      // ── run the checks ONCE up front to capture the failing output for the prompt ──
      const baseline = await runVerification(deps, ctx.workspace.path);
      lastVerification = baseline;

      // The goal + file bodies + check output are UNTRUSTED — neutralize before the model loop (#8).
      const untrusted = (body: string, origin: string): ModelMessage => {
        neutralizedCount += 1;
        return toUntrustedMessage(ctx.engine.neutralizeUntrusted(body, { source: "external", identity: ctx.identity, origin }), { role: "user" });
      };

      const contextBody = buildContextBody({ goal: ctx.task.goal, files: contextFiles, checkOutput: baseline.ran ? baseline.output : undefined, forbidden });
      const messages: ModelMessage[] = [{ role: "system", content: PATCHSMITH_SYSTEM }, untrusted(contextBody, "patchsmith_context")];

      // ── attempt loop: one initial patch, then up to PATCHSMITH_MAX_REPAIRS repairs ──
      for (let attempt = 0; attempt <= PATCHSMITH_MAX_REPAIRS; attempt += 1) {
        const response = await ctx.engine.invokeModel({
          model: modelId,
          temperature: PATCHSMITH_TEMPERATURE,
          maxTokens: effectiveMaxTokens,
          identity: ctx.identity,
          messages,
          // NO `tools` — the patchsmith lane is, by construction, tool-free.
        });
        patchAttempts += 1;
        messages.push({ role: "assistant", content: response.content });

        const extracted = extractDiff(response.content);
        if (extracted.kind === "need_context") {
          needContext = extracted.files;
          stopReason = "need_more_context";
          break;
        }
        if (extracted.kind === "malformed") {
          rejected.push({ tool: "patch", error: extracted.reason });
          stopReason = "malformed_patch";
          // Feed the parse failure back so the repair attempt (if any) can correct format.
          messages.push({ role: "user", content: `Your reply was not a valid unified diff: ${extracted.reason}. Reply with ONLY a unified diff (--- a/file, +++ b/file, @@ hunks @@).` });
          if (attempt < PATCHSMITH_MAX_REPAIRS) {
            repairAttempts += 1;
            continue;
          }
          break;
        }

        const parsed = parseUnifiedDiff(extracted.text);
        if (!parsed.ok) {
          rejected.push({ tool: "patch", error: parsed.error });
          stopReason = "malformed_patch";
          messages.push({ role: "user", content: `Your diff could not be parsed: ${parsed.error}. Reply with ONLY a valid unified diff.` });
          if (attempt < PATCHSMITH_MAX_REPAIRS) {
            repairAttempts += 1;
            continue;
          }
          break;
        }

        // VALIDATE every touched path BEFORE writing a single byte (reject the patch WHOLE).
        const plans: Array<{ patch: FilePatch; rel: string; full: string; exists: boolean }> = [];
        let violation: string | undefined;
        for (const fp of parsed.files) {
          const c = confinePath(worktreeReal, fp.path);
          if (!c.ok) {
            violation = c.error;
            break;
          }
          const exists = existsSync(c.full);
          const v = patchPathViolation(c.rel, { forbidden, allowTests, writeScope, exists });
          if (v !== undefined) {
            violation = v;
            break;
          }
          plans.push({ patch: fp, rel: c.rel, full: c.full, exists });
        }
        if (violation !== undefined) {
          rejected.push({ tool: "patch", error: violation });
          stopReason = "rejected_forbidden";
          // A forbidden-file patch is a hard stop — do NOT spend the repair budget re-trying it.
          break;
        }

        // APPLY — compute new contents first (fail closed if any hunk misses), then write atomically.
        const writes: Array<{ full: string; rel: string; content: string | null }> = [];
        let applyError: string | undefined;
        for (const p of plans) {
          if (p.patch.deleted) {
            writes.push({ full: p.full, rel: p.rel, content: null });
            continue;
          }
          const original = p.exists ? readFileSync(p.full, "utf8") : "";
          const applied = applyFilePatch(original, p.patch);
          if (!applied.ok) {
            applyError = applied.error;
            break;
          }
          writes.push({ full: p.full, rel: p.rel, content: applied.content });
        }
        if (applyError !== undefined) {
          rejected.push({ tool: "patch", error: applyError });
          stopReason = "patch_did_not_apply";
          messages.push({ role: "user", content: `The patch did not apply cleanly: ${applyError}. Re-read the file context and produce a corrected unified diff.` });
          if (attempt < PATCHSMITH_MAX_REPAIRS) {
            repairAttempts += 1;
            continue;
          }
          break;
        }
        for (const w of writes) {
          if (w.content === null) {
            if (existsSync(w.full)) rmSync(w.full);
          } else {
            mkdirSync(dirname(w.full), { recursive: true });
            writeFileSync(w.full, w.content, "utf8");
          }
          filesChanged.add(w.rel);
        }
        log.info({ filesChanged: [...filesChanged], attempt }, "patchsmith applied a patch");

        // VERIFY — the SAME governed ladder the verifier runs. A green verdict is the only success.
        const verification = await runVerification(deps, ctx.workspace.path);
        lastVerification = verification;
        if (verification.allPass && verification.ran) {
          stopReason = "verified";
          break;
        }
        // Red verdict → ONE repair: hand the model the failing output (spec test #6).
        stopReason = "verification_failed";
        if (attempt < PATCHSMITH_MAX_REPAIRS) {
          repairAttempts += 1;
          messages.push({
            role: "user",
            content:
              "The patch was applied but verification FAILED. Here is the check output:\n" +
              `${verification.output}\n\n` +
              "Produce a corrected unified diff that fixes the remaining failures. Return ONLY the diff.",
          });
          continue;
        }
        break;
      }
    } catch (err) {
      return {
        role: "builder",
        outcome: "failure",
        summary: `patchsmith failed: ${errMsg(err)}`,
        detail: { builderMode: "patch", model: modelId, filesSupplied, filesChanged: [...filesChanged], patchAttempts, repairAttempts, rejectedPatches: rejected, verificationResult: "error", stopReason: "exception" },
      };
    }

    const outcome = classify(stopReason);
    const verificationResult = lastVerification.allPass && lastVerification.ran ? "pass" : lastVerification.ran ? "fail" : "not_run";
    const routingReason = `model "${modelId}" runs the patchsmith lane: no tool loop — context → unified diff → apply → verify (${PATCHSMITH_MAX_REPAIRS} repair max)`;
    const summary =
      `patchsmith ${outcome} (stop: ${stopReason}); ${patchAttempts} patch attempt(s), ${repairAttempts} repair(s); ` +
      `changed ${filesChanged.size} file(s); verification ${verificationResult}` +
      (needContext !== undefined ? `; needs more context: ${needContext.join(", ")}` : "");

    return {
      role: "builder",
      outcome,
      summary,
      detail: {
        builderMode: "patch",
        model: modelId,
        patchAttempts,
        repairAttempts,
        filesSupplied,
        filesChanged: [...filesChanged],
        // Aliases the orchestrator's builder-activity event + competitive judge read off the
        // builder detail (`filesWritten`, `toolRounds`) — the patchsmith has no tool loop, so
        // toolRounds is the patch-attempt count and filesWritten mirrors filesChanged.
        filesWritten: [...filesChanged],
        toolRounds: patchAttempts,
        verificationResult,
        stopReason,
        neutralizedCount,
        rejectedPatches: rejected,
        routingReason,
        ...(needContext !== undefined ? { needContext } : {}),
        ...(lastVerification.ran ? { lastChecks: { allPass: lastVerification.allPass } } : {}),
        autoCommit: ctx.autonomy.autoCommit,
        tier: ctx.autonomy.tier,
      },
    };
  };
}

/**
 * Run the SAME governed ladder checks the verifier uses, returning a pass/fail + the structured
 * failing output (reused from the builder's run_checks discipline: governed exec, the resolved
 * check set, the per-check budget, and the false-green triage). Fails CLOSED (allPass false) when
 * the parent identity or a project root is missing — a patch can never go green on a vacuous run.
 */
async function runVerification(deps: PatchsmithDeps, workspacePath: string): Promise<{ allPass: boolean; output: string; ran: boolean }> {
  if (deps.parentCtx === undefined) {
    return { allPass: false, output: "ERROR: checks unavailable (no parent identity wired to authorize them)", ran: false };
  }
  const governedExec = deps.governedExec ?? lazyGovernedExec();
  const resolveChecks = deps.resolveChecks ?? ((): ChecksResolution => ({ ok: true, checks: VERIFIER_CHECKS, source: "default" }));
  const resolved = resolveChecks(workspacePath);
  if (!resolved.ok) return { allPass: false, output: `ERROR: ${resolved.reason}`, ran: false };

  const checkTimeoutMs = resolveCheckTimeoutMs();
  const results: CheckResult[] = [];
  let dry = false;
  for (const c of resolved.checks) {
    const res = await governedExec.run({
      parentCtx: deps.parentCtx,
      command: c.command,
      args: [...c.args],
      cwd: workspacePath,
      purpose: `patchsmith check: ${c.name}`,
      timeoutMs: checkTimeoutMs,
    });
    const { check, dryRun } = mapExec(c.name, `${c.command} ${c.args.join(" ")}`, res);
    results.push(check);
    dry = dry || dryRun;
  }
  // FALSE-GREEN HARDENING: exit 0 is a floor, not a ceiling — route through the triage parser.
  const triaged = results.map((r) => ({ result: r, triage: parseCheckOutput({ name: r.name, command: r.command, exitCode: r.exitCode, stdout: r.outputTail }) }));
  const allPass = !dry && triaged.length > 0 && triaged.every((t) => t.triage.passed);
  const blocks = triaged.map(({ result: r, triage }) => (triage.passed ? `[check: ${r.name}] PASS` : `[check: ${r.name}] FAILED\n  error: ${triage.errorSummary}\n  output:\n${r.outputTail}`));
  const header = allPass ? "CHECK RESULTS: ALL PASS" : `CHECK RESULTS: FAILED (${triaged.filter((t) => !t.triage.passed).length} of ${triaged.length} failing)`;
  return { allPass, output: `${header}\n${blocks.join("\n---\n")}`, ran: true };
}

/** Lazy governed-exec singleton fallback (same pattern the agent builder uses). */
function lazyGovernedExec(): Pick<GovernedExec, "run"> {
  return { run: async (req) => (await import("../governed-exec/index.js")).governedExec.run(req) };
}

/** Compact error message extraction (never throws). */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The default patchsmith (no governed checks wired) — the orchestrator injects deps at dispatch. */
export const patchsmith: RoleFn = createPatchsmith();
