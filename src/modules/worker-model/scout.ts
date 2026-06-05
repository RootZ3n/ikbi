/**
 * ikbi worker-model — SCOUT role (Pass A: read-only investigation, model-driven).
 *
 * Scoped (pending 3-eyes): gather repo/context relevant to the goal and produce
 * findings. STRICTLY READ-ONLY — scout never writes, stages, or mutates anything
 * under the workspace or target repo; it only lists/reads a BOUNDED set of files
 * and asks a model to analyze them.
 *
 * UNTRUSTED INPUT (C4): the goal, task metadata, and especially the repository
 * EXCERPTS (raw file contents — a malicious repo file could embed instructions) are
 * untrusted DATA. Each enters the prompt through `ctx.engine.neutralizeUntrusted` +
 * `toUntrustedMessage` (a structurally-isolated data-role message, `untrusted: true`),
 * never raw-concatenated into the trusted SYSTEM instructions. Same chokepoint the
 * newer modules use (agent-router / cognition).
 *
 * Every model call carries `identity: ctx.identity` — the spawned, ceiling-clamped
 * role identity (#10).
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { toUntrustedMessage } from "../../core/injection/index.js";
import type { ModelMessage, ModelRequest } from "../../core/provider/contract.js";
import type { RoleFn } from "./contract.js";

/** A single thing scout learned. Lives in the open `detail` bag — NOT a contract type. */
export interface ScoutFinding {
  readonly title: string;
  readonly detail: string;
  readonly files?: readonly string[];
}

// --- named constants (no magic values inline) ------------------------------
const SCOUT_MODEL = "mimo-v2.5"; // the driver-tier logical roster id
const SCOUT_TEMPERATURE = 0.2;
const SCOUT_MAX_TOKENS = 1024;
/** Hard cap on files visited — scout never walks the whole tree. */
const MAX_FILES_SCANNED = 40;
/** Per-file byte cap fed to the model. */
const MAX_FILE_BYTES = 4_000;
/** Total byte cap of gathered context. */
const MAX_TOTAL_BYTES = 60_000;
const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md"]);
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);

const SCOUT_SYSTEM =
  "You are the SCOUT in a build pipeline. Investigate the provided repository " +
  "excerpts against the stated goal and list concise, concrete findings (one per " +
  "line, starting with '- '): what exists, what's relevant, and what the builder " +
  "should know. Read-only — do not propose edits.";

/** Bounded, read-only directory walk. Stops at MAX_FILES_SCANNED; skips heavy dirs. */
function gatherFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_FILES_SCANNED) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip (read-only, never fail the walk on one dir)
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_SCANNED) break;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && SCAN_EXTENSIONS.has(extname(e.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Read a bounded slice of each file into a single context string. Read-only. */
function buildContext(files: readonly string[], root: string): { text: string; used: number } {
  const parts: string[] = [];
  let total = 0;
  let used = 0;
  for (const f of files) {
    if (total >= MAX_TOTAL_BYTES) break;
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const slice = content.slice(0, MAX_FILE_BYTES);
    parts.push(`--- ${relative(root, f)} ---\n${slice}`);
    total += Buffer.byteLength(slice, "utf8");
    used += 1;
  }
  return { text: parts.join("\n\n"), used };
}

/** Parse the model's bullet output into findings; fall back to one finding. */
function parseFindings(content: string): ScoutFinding[] {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l) || /^\d+[.)]\s+/.test(l));
  if (bullets.length > 0) {
    return bullets.map((l, i) => ({ title: `finding-${i + 1}`, detail: l.replace(/^([-*]|\d+[.)])\s+/, "") }));
  }
  const detail = content.trim();
  return [{ title: "investigation", detail: detail.length > 0 ? detail : "(no analysis returned)" }];
}

export const scout: RoleFn = async (ctx) => {
  try {
    const root = ctx.workspace.path;
    const files = gatherFiles(root); // bounded, read-only
    const { text, used } = buildContext(files, root);

    // C4: each untrusted block is neutralized + wrapped as an isolated data-role
    // message (untrusted:true) — never raw-concatenated into the trusted system prompt.
    const untrusted = (raw: string, origin: string): ModelMessage =>
      toUntrustedMessage(ctx.engine.neutralizeUntrusted(raw, { source: "external", identity: ctx.identity, origin }), { role: "user" });

    const request: ModelRequest = {
      model: SCOUT_MODEL,
      temperature: SCOUT_TEMPERATURE,
      maxTokens: SCOUT_MAX_TOKENS,
      identity: ctx.identity, // the spawned, ceiling-clamped role identity (#10)
      messages: [
        { role: "system", content: SCOUT_SYSTEM },
        untrusted(`Goal:\n${ctx.task.goal}`, "scout_goal"),
        untrusted(`Task metadata: ${JSON.stringify(ctx.task.metadata ?? {})}`, "scout_metadata"),
        untrusted(`Repository excerpts (${used} file(s)):\n${text}`, "scout_repo_excerpts"),
      ],
    };

    const response = await ctx.engine.invokeModel(request);
    const findings = parseFindings(response.content);
    return {
      role: "scout",
      outcome: "success",
      summary: `scouted ${used} file(s); produced ${findings.length} finding(s)`,
      detail: { findings, filesScanned: used },
    };
  } catch (err) {
    // IO / model failure: report at the role boundary, do not throw past it.
    return {
      role: "scout",
      outcome: "failure",
      summary: `scout failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
