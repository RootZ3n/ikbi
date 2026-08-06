/**
 * ikbi agent tool — notebook_edit.
 *
 * Jupyter notebooks (.ipynb) are JSON, but hand-editing them through write_file is brittle: a model
 * has to reproduce the whole nbformat envelope (cells, metadata, outputs, execution_count) byte for
 * byte, and a single mistake corrupts the file. This tool gives a cell-level API instead — read the
 * cells, insert/edit/delete one by index — and round-trips the nbformat-4 structure for the model.
 *
 * It is a CONFINED file operation (sync): every path resolves against the worktree through the same
 * `confinePath` resolver every other file tool uses, so a notebook outside the tree is rejected. Cell
 * EXECUTION is intentionally NOT here — the model runs `jupyter execute` (or any runner) through the
 * existing `terminal` tool, which is governed/allowlisted; this tool only edits the document.
 *
 * TRUST: a notebook is repo content. `read` output (cell source + captured outputs) is UNTRUSTED —
 * the caller neutralizes it at its chokepoint before it re-enters the model (same as read_file).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";

import type { ModelTool } from "../../core/provider/contract.js";
import { MutationError } from "../../core/workspace/mutation.js";
import type { MutationSessionLike } from "../../core/workspace/mutation-session.js";
import { confinePath, type BuilderToolResult } from "../worker-model/builder-tools/confine.js";

/** The tool declared to the model. */
export const notebookEditTool: ModelTool = {
  name: "notebook_edit",
  description:
    "Read and edit a Jupyter notebook (.ipynb) at the CELL level instead of rewriting raw JSON. " +
    "Operations: `read` (list every cell with its index, type, source, and — for code cells — captured outputs); " +
    "`insert` (add a new cell at `cell_index`, or append when omitted); `edit` (replace the source of the cell at `cell_index`); " +
    "`delete` (remove the cell at `cell_index`). `cell_type` is code or markdown. To run cells, use the terminal tool (e.g. `jupyter execute`). " +
    'Example: {"path": "analysis.ipynb", "operation": "edit", "cell_index": 2, "source": "import pandas as pd"}',
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Worktree-relative path to the .ipynb file." },
      operation: { type: "string", enum: ["read", "insert", "edit", "delete"], description: "What to do." },
      cell_index: { type: "number", description: "0-based cell index for edit/delete, or the insert position (omit to append)." },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type for insert/edit (default: code)." },
      source: { type: "string", description: "The cell's source text (for insert/edit)." },
    },
    required: ["path", "operation"],
  },
};

/** Minimal nbformat-4 cell shape (we preserve unknown fields on edit). */
interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

/** Run notebook_edit. Sync, confined, never throws past the boundary (errors become `ERROR:` strings). */
export function runNotebookEdit(worktreeReal: string, args: Record<string, unknown>): BuilderToolResult {
  const operation = typeof args.operation === "string" ? args.operation : "";
  if (operation.length === 0) {
    return { output: "ERROR: notebook_edit requires an 'operation' (read | insert | edit | delete).", rejection: { tool: "notebook_edit", error: "missing operation" } };
  }
  const c = confinePath(worktreeReal, args.path);
  if (!c.ok) {
    return { output: `ERROR: ${c.error}`, rejection: { tool: "notebook_edit", path: String(args.path ?? ""), error: c.error } };
  }
  if (!c.rel.endsWith(".ipynb")) {
    return { output: `ERROR: notebook_edit only operates on .ipynb files (got "${c.rel}").`, rejection: { tool: "notebook_edit", path: c.rel, error: "not an .ipynb file" } };
  }

  switch (operation) {
    case "read":
      return readNotebook(c.full, c.rel);
    case "insert":
      return insertCell(c.full, c.rel, args);
    case "edit":
      return editCell(c.full, c.rel, args);
    case "delete":
      return deleteCell(c.full, c.rel, args);
    default:
      return { output: `ERROR: unknown notebook operation "${operation}" (use read | insert | edit | delete).`, rejection: { tool: "notebook_edit", path: c.rel, error: "unknown operation" } };
  }
}

/**
 * State-bound notebook editing used by the managed builder/chat executor.
 *
 * The legacy synchronous helper above remains for non-candidate compatibility and its existing
 * tests. Managed callers never use it for candidate content: this function derives the complete
 * serialized notebook from the session's exact retained bytes and hands those bytes to Phase 1.
 */
export async function runBoundNotebookEdit(
  session: MutationSessionLike,
  args: Record<string, unknown>,
): Promise<BuilderToolResult & { readonly before?: string; readonly after?: string }> {
  const operation = typeof args.operation === "string" ? args.operation : "";
  if (operation.length === 0) {
    throw new MutationError("MUTATION_VALIDATION", "notebook_edit requires an 'operation'", { path: String(args.path ?? "") });
  }
  const requestedPath = typeof args.path === "string" ? args.path : "";
  if (!requestedPath.endsWith(".ipynb")) {
    throw new MutationError("MUTATION_VALIDATION", `notebook_edit only operates on .ipynb files (got "${requestedPath}")`, { path: requestedPath });
  }

  const prior = session.currentObservation(requestedPath);
  const hasPriorFullObservation = prior !== undefined;
  const observed = operation === "read" || prior === undefined ? await session.observeBytes(requestedPath) : prior;
  const path = observed.path;
  if (operation === "read") {
    if (observed.observation.kind === "missing" || observed.bytes === null) {
      session.discardObservation(path);
      throw new MutationError("MUTATION_VALIDATION", `read failed: notebook does not exist at ${path}`, { path });
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes);
      const parsed = parseNotebookText(text);
      if (!parsed.ok) throw new MutationError("MUTATION_VALIDATION", parsed.error, { path });
      const result = readNotebookObject(parsed.nb, path);
      // A summary is not a whole-file observation. Do not let notebook read output authorize a
      // later generic write_file/patch; a bound edit must follow a complete read_file or use an
      // explicit create-intent for a missing file.
      session.discardObservation(path);
      return result;
    } catch (error) {
      session.discardObservation(path);
      throw error;
    }
  }

  let notebook: Notebook;
  let beforeBytes: Buffer;
  if (observed.observation.kind === "missing") {
    if (operation !== "insert") {
      session.discardObservation(path);
      throw new MutationError("MUTATION_VALIDATION", `${operation} requires an observed existing notebook at ${path}`, { path });
    }
    notebook = freshNotebook();
    beforeBytes = Buffer.alloc(0);
  } else {
    if (!hasPriorFullObservation) {
      session.discardObservation(path);
      throw new MutationError("MUTATION_VALIDATION", `complete read_file observation required before editing ${path}`, { path });
    }
    if (observed.bytes === null || (observed.observation.kind !== "empty" && observed.observation.kind !== "regular")) {
      session.discardObservation(path);
      throw new MutationError("MUTATION_VALIDATION", `notebook_edit requires a regular notebook file at ${path}`, { path });
    }
    beforeBytes = Buffer.from(observed.bytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(beforeBytes);
      const parsed = parseNotebookText(text);
      if (!parsed.ok) throw new MutationError("MUTATION_VALIDATION", parsed.error, { path });
      notebook = parsed.nb;
    } catch (error) {
      session.discardObservation(path);
      throw error;
    }
  }

  const operationResult = applyNotebookOperation(notebook, operation, args, path);
  if (!operationResult.ok) {
    session.discardObservation(path);
    throw new MutationError("MUTATION_VALIDATION", operationResult.error, { path });
  }
  const afterBytes = Buffer.from(serializeNotebook(notebook), "utf8");
  if (observed.observation.kind === "missing") await session.createBytes(path, afterBytes);
  else await session.replaceBytes(path, afterBytes);
  return {
    output: operationResult.output,
    wrote: path,
    ...(observed.observation.kind === "missing" ? {} : { before: beforeBytes.toString("utf8") }),
    after: afterBytes.toString("utf8"),
  };
}

function parseNotebookText(text: string): { ok: true; nb: Notebook } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not a valid .ipynb (JSON parse failed): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Notebook).cells)) {
    return { ok: false, error: "not a valid notebook (missing 'cells' array)" };
  }
  return { ok: true, nb: parsed as Notebook };
}

function serializeNotebook(nb: Notebook): string {
  return `${JSON.stringify(nb, null, 1)}\n`;
}

function readNotebookObject(nb: Notebook, rel: string): BuilderToolResult {
  if (nb.cells.length === 0) return { output: `Notebook ${rel} has no cells (nbformat ${nb.nbformat ?? "?"}).` };
  const lines: string[] = [`Notebook ${rel} — ${nb.cells.length} cell(s), nbformat ${nb.nbformat ?? "?"}:`];
  nb.cells.forEach((cell, i) => {
    const src = sourceToString(cell.source);
    const bounded = src.length > 1_000 ? `${src.slice(0, 1_000)}\n… [${src.length} chars total]` : src;
    lines.push(`--- cell [${i}] (${cell.cell_type}) ---`);
    lines.push(bounded.length > 0 ? bounded : "(empty)");
    if (cell.cell_type === "code" && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const outSummary = summarizeOutputs(cell.outputs);
      if (outSummary.length > 0) lines.push(`  outputs:\n${outSummary}`);
    }
  });
  return { output: lines.join("\n") };
}

function applyNotebookOperation(
  nb: Notebook,
  operation: string,
  args: Record<string, unknown>,
  path: string,
): { ok: true; output: string } | { ok: false; error: string } {
  if (operation === "insert") {
    const source = typeof args.source === "string" ? args.source : "";
    const cell = makeCell(resolveCellType(args), source);
    const idx = typeof args.cell_index === "number" ? clampIndex(args.cell_index, nb.cells.length) : nb.cells.length;
    nb.cells.splice(idx, 0, cell);
    return { ok: true, output: `Inserted ${cell.cell_type} cell at index ${idx} in ${path} (now ${nb.cells.length} cell(s)).` };
  }
  if (operation === "edit") {
    if (typeof args.cell_index !== "number") return { ok: false, error: "edit requires a numeric 'cell_index'." };
    const idx = args.cell_index;
    if (idx < 0 || idx >= nb.cells.length) return { ok: false, error: `cell_index ${idx} out of range (notebook has ${nb.cells.length} cell(s)).` };
    const cell = nb.cells[idx] as NotebookCell;
    if (typeof args.source === "string") cell.source = stringToSource(args.source);
    if (args.cell_type === "code" || args.cell_type === "markdown") {
      const newType = args.cell_type;
      if (newType !== cell.cell_type) {
        cell.cell_type = newType;
        if (newType === "code") {
          if (cell.outputs === undefined) cell.outputs = [];
          if (cell.execution_count === undefined) cell.execution_count = null;
        } else {
          delete cell.outputs;
          delete cell.execution_count;
        }
      }
    }
    if (cell.cell_type === "code" && typeof args.source === "string") {
      cell.outputs = [];
      cell.execution_count = null;
    }
    return { ok: true, output: `Edited cell [${idx}] (${cell.cell_type}) in ${path}.` };
  }
  if (operation === "delete") {
    if (typeof args.cell_index !== "number") return { ok: false, error: "delete requires a numeric 'cell_index'." };
    const idx = args.cell_index;
    if (idx < 0 || idx >= nb.cells.length) return { ok: false, error: `cell_index ${idx} out of range (notebook has ${nb.cells.length} cell(s)).` };
    const [removed] = nb.cells.splice(idx, 1);
    return { ok: true, output: `Deleted cell [${idx}] (${removed?.cell_type ?? "?"}) from ${path} (now ${nb.cells.length} cell(s)).` };
  }
  return { ok: false, error: `unknown notebook operation "${operation}" (use read | insert | edit | delete).` };
}

/** Load + parse a notebook from disk; returns an error string on failure. */
function loadNotebook(full: string): { ok: true; nb: Notebook } | { ok: false; error: string } {
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (e) {
    return { ok: false, error: `read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not a valid .ipynb (JSON parse failed): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Notebook).cells)) {
    return { ok: false, error: "not a valid notebook (missing 'cells' array)" };
  }
  return { ok: true, nb: parsed as Notebook };
}

/** Serialize + atomically-ish write a notebook (pretty JSON, trailing newline — matches Jupyter). */
function writeNotebook(full: string, nb: Notebook): void {
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(nb, null, 1)}\n`, "utf8");
}

/** Coerce nbformat source (string | string[]) to a single string. */
function sourceToString(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : typeof source === "string" ? source : "";
}

/** Split a source string into the nbformat line-array form (each line keeps its trailing \n). */
function stringToSource(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  return parts.map((line, i) => (i < parts.length - 1 ? `${line}\n` : line)).filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ""));
}

/** Render a code cell's captured outputs into a compact, readable summary. */
function summarizeOutputs(outputs: unknown[]): string {
  const parts: string[] = [];
  for (const out of outputs) {
    if (typeof out !== "object" || out === null) continue;
    const o = out as Record<string, unknown>;
    const type = typeof o.output_type === "string" ? o.output_type : "";
    if (type === "stream") {
      parts.push(`    [stream:${typeof o.name === "string" ? o.name : "stdout"}] ${collapse(textOf(o.text))}`);
    } else if (type === "execute_result" || type === "display_data") {
      const data = o.data as Record<string, unknown> | undefined;
      const plain = data !== undefined ? textOf(data["text/plain"]) : "";
      parts.push(`    [result] ${collapse(plain)}`);
    } else if (type === "error") {
      parts.push(`    [error] ${typeof o.ename === "string" ? o.ename : ""}: ${typeof o.evalue === "string" ? o.evalue : ""}`);
    }
  }
  return parts.join("\n");
}

function textOf(v: unknown): string {
  return Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
}

/** Collapse output text to a bounded single-ish line for the read summary. */
function collapse(text: string): string {
  const trimmed = text.replace(/\s+$/g, "");
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

function readNotebook(full: string, rel: string): BuilderToolResult {
  const loaded = loadNotebook(full);
  if (!loaded.ok) return { output: `ERROR: ${loaded.error}`, rejection: { tool: "notebook_edit", path: rel, error: loaded.error } };
  const { nb } = loaded;
  if (nb.cells.length === 0) return { output: `Notebook ${rel} has no cells (nbformat ${nb.nbformat ?? "?"}).` };
  const lines: string[] = [`Notebook ${rel} — ${nb.cells.length} cell(s), nbformat ${nb.nbformat ?? "?"}:`];
  nb.cells.forEach((cell, i) => {
    const src = sourceToString(cell.source);
    const bounded = src.length > 1_000 ? `${src.slice(0, 1_000)}\n… [${src.length} chars total]` : src;
    lines.push(`--- cell [${i}] (${cell.cell_type}) ---`);
    lines.push(bounded.length > 0 ? bounded : "(empty)");
    if (cell.cell_type === "code" && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const outSummary = summarizeOutputs(cell.outputs);
      if (outSummary.length > 0) lines.push(`  outputs:\n${outSummary}`);
    }
  });
  return { output: lines.join("\n") };
}

function makeCell(cellType: "code" | "markdown", source: string): NotebookCell {
  const base: NotebookCell = { cell_type: cellType, metadata: {}, source: stringToSource(source) };
  if (cellType === "code") {
    base.outputs = [];
    base.execution_count = null;
  }
  return base;
}

/** A fresh empty nbformat-4 notebook (for insert into a not-yet-existing file). */
function freshNotebook(): Notebook {
  return {
    cells: [],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function resolveCellType(args: Record<string, unknown>): "code" | "markdown" {
  return args.cell_type === "markdown" ? "markdown" : "code";
}

function insertCell(full: string, rel: string, args: Record<string, unknown>): BuilderToolResult {
  let nb: Notebook;
  if (existsSync(full)) {
    const loaded = loadNotebook(full);
    if (!loaded.ok) return { output: `ERROR: ${loaded.error}`, rejection: { tool: "notebook_edit", path: rel, error: loaded.error } };
    nb = loaded.nb;
  } else {
    nb = freshNotebook();
  }
  const source = typeof args.source === "string" ? args.source : "";
  const cell = makeCell(resolveCellType(args), source);
  const idx = typeof args.cell_index === "number" ? clampIndex(args.cell_index, nb.cells.length) : nb.cells.length;
  nb.cells.splice(idx, 0, cell);
  writeNotebook(full, nb);
  return { output: `Inserted ${cell.cell_type} cell at index ${idx} in ${rel} (now ${nb.cells.length} cell(s)).`, wrote: rel };
}

function editCell(full: string, rel: string, args: Record<string, unknown>): BuilderToolResult {
  const loaded = loadNotebook(full);
  if (!loaded.ok) return { output: `ERROR: ${loaded.error}`, rejection: { tool: "notebook_edit", path: rel, error: loaded.error } };
  const { nb } = loaded;
  if (typeof args.cell_index !== "number") {
    return { output: "ERROR: edit requires a numeric 'cell_index'.", rejection: { tool: "notebook_edit", path: rel, error: "missing cell_index" } };
  }
  const idx = args.cell_index;
  if (idx < 0 || idx >= nb.cells.length) {
    return { output: `ERROR: cell_index ${idx} out of range (notebook has ${nb.cells.length} cell(s)).`, rejection: { tool: "notebook_edit", path: rel, error: "cell_index out of range" } };
  }
  const cell = nb.cells[idx] as NotebookCell;
  if (typeof args.source === "string") cell.source = stringToSource(args.source);
  if (args.cell_type === "code" || args.cell_type === "markdown") {
    const newType = args.cell_type;
    if (newType !== cell.cell_type) {
      cell.cell_type = newType;
      if (newType === "code") {
        if (cell.outputs === undefined) cell.outputs = [];
        if (cell.execution_count === undefined) cell.execution_count = null;
      } else {
        delete cell.outputs;
        delete cell.execution_count;
      }
    }
  }
  // Editing a code cell's source invalidates any captured outputs — clear them (Jupyter does the same).
  if (cell.cell_type === "code" && typeof args.source === "string") {
    cell.outputs = [];
    cell.execution_count = null;
  }
  writeNotebook(full, nb);
  return { output: `Edited cell [${idx}] (${cell.cell_type}) in ${rel}.`, wrote: rel };
}

function deleteCell(full: string, rel: string, args: Record<string, unknown>): BuilderToolResult {
  const loaded = loadNotebook(full);
  if (!loaded.ok) return { output: `ERROR: ${loaded.error}`, rejection: { tool: "notebook_edit", path: rel, error: loaded.error } };
  const { nb } = loaded;
  if (typeof args.cell_index !== "number") {
    return { output: "ERROR: delete requires a numeric 'cell_index'.", rejection: { tool: "notebook_edit", path: rel, error: "missing cell_index" } };
  }
  const idx = args.cell_index;
  if (idx < 0 || idx >= nb.cells.length) {
    return { output: `ERROR: cell_index ${idx} out of range (notebook has ${nb.cells.length} cell(s)).`, rejection: { tool: "notebook_edit", path: rel, error: "cell_index out of range" } };
  }
  const [removed] = nb.cells.splice(idx, 1);
  writeNotebook(full, nb);
  return { output: `Deleted cell [${idx}] (${removed?.cell_type ?? "?"}) from ${rel} (now ${nb.cells.length} cell(s)).`, wrote: rel };
}

/** Clamp an insert position into [0, len]. */
function clampIndex(idx: number, len: number): number {
  if (idx < 0) return 0;
  if (idx > len) return len;
  return Math.floor(idx);
}
