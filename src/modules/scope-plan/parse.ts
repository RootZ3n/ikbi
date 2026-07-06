/**
 * ikbi scope-plan — parser.
 *
 * Parses a SCOPE.md into an ordered {@link ScopePlan}. The format is deliberately FORGIVING so an
 * operator can author it as plain markdown. A STAGE begins at any of:
 *   - a numbered list item:  `1. Core contracts`  /  `2) Storage domain`
 *   - a bullet:              `- Core contracts`     /  `* Storage domain`
 *   - an H2/H3 heading:      `## Stage 1: core contracts`
 * Lines between one stage marker and the next (that are not themselves markers) are the stage's
 * BODY — appended to its goal. A leading H1 (`# Title`) and any preamble before the first marker
 * are ignored. Two optional inline directives:
 *   - `(verify)` anywhere on the marker line ⇒ this stage opts into intermediate verification.
 *   - a body line `files: a.ts, b.ts` ⇒ the stage's targetFiles (comma/whitespace separated).
 */

import { MAX_SCOPE_STAGES } from "./config.js";
import type { ScopePlan, ScopeStage } from "./contract.js";

/** A stage marker: numbered (`1.`/`1)`), bullet (`-`/`*`/`+`), or H2/H3 heading. Captures the text. */
const STAGE_MARKER = /^\s*(?:\d+[.)]\s+|[-*+]\s+|#{2,3}\s+)(.*\S)\s*$/;
/** An H1 line — a document title, never a stage. */
const H1 = /^\s*#\s+\S/;
/** A `(verify)` / `[verify]` marker (case-insensitive), anywhere on the marker line. */
const VERIFY_MARKER = /[([]\s*verify\s*[)\]]/i;
/** A body directive naming the stage's target files: `files: a.ts, b.ts` (or `targets:`). */
const FILES_DIRECTIVE = /^\s*(?:files|targets)\s*:\s*(.+)$/i;

interface DraftStage {
  title: string;
  bodyLines: string[];
  verify: boolean;
  targetFiles: string[];
}

/** Split a `files:` directive value into distinct file tokens (comma and/or whitespace separated). */
function parseFiles(raw: string): string[] {
  return [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Parse a SCOPE.md string into an ordered scope plan. Returns `{ stages: [] }` when the file has no
 * recognizable stage markers (the caller then falls back to a normal single/heuristic build) — a
 * malformed or empty file NEVER throws and NEVER fabricates stages.
 */
export function parseScopePlan(markdown: string): ScopePlan {
  const drafts: DraftStage[] = [];
  let current: DraftStage | undefined;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim().length === 0) continue; // blank — a paragraph break, ignored
    if (H1.test(line)) {
      current = undefined; // an H1 ends any open stage's body and starts fresh preamble
      continue;
    }
    const marker = STAGE_MARKER.exec(line);
    if (marker) {
      if (drafts.length >= MAX_SCOPE_STAGES) break; // safety cap — stop parsing further stages
      const rawTitle = marker[1] ?? "";
      const verify = VERIFY_MARKER.test(rawTitle);
      const title = rawTitle.replace(VERIFY_MARKER, "").replace(/\s{2,}/g, " ").trim();
      current = { title, bodyLines: [], verify, targetFiles: [] };
      drafts.push(current);
      continue;
    }
    // A non-marker, non-blank line is BODY for the current stage (ignored if before the first stage).
    if (current === undefined) continue;
    const files = FILES_DIRECTIVE.exec(line);
    if (files) {
      current.targetFiles.push(...parseFiles(files[1] ?? ""));
      continue; // a directive is not prose — it does not become part of the goal
    }
    current.bodyLines.push(line.trim());
  }

  const stages: ScopeStage[] = drafts
    .filter((d) => d.title.length > 0 || d.bodyLines.length > 0)
    .map((d, i) => {
      const body = d.bodyLines.join(" ").trim();
      const goal = body.length > 0 ? (d.title.length > 0 ? `${d.title} — ${body}` : body) : d.title;
      return {
        index: i + 1,
        title: d.title.length > 0 ? d.title : goal,
        goal,
        ...(d.targetFiles.length > 0 ? { targetFiles: d.targetFiles } : {}),
        verify: d.verify,
      };
    });

  return { stages, source: "scope" };
}
