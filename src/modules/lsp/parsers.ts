/**
 * ikbi LSP module — output parsers.
 *
 * One parser per diagnostic engine. Each takes the raw stdout/stderr a command produced and
 * normalizes it to `LspDiagnostic[]` (1-based line/column, uniform severity). Parsers are pure
 * and total: malformed/garbage input yields `[]`, never a throw — a parse failure must degrade
 * to "no diagnostics found", not crash the tool. Kept separate from the runner so each format is
 * unit-testable against captured fixtures.
 */

import type { LspDiagnostic } from "./contract.js";

/** Normalize any tool path to a forward-slash, root-relative-ish display path. */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * tsc --noEmit --pretty false output:
 *   src/foo.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.
 *   src/foo.ts:12:5 - error TS2322: ...        (alternate `--pretty`-ish form, handled too)
 */
export function parseTsc(output: string): LspDiagnostic[] {
  const diags: LspDiagnostic[] = [];
  const paren = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+([A-Z]+\d+):\s+(.*)$/;
  const colon = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning|info)\s+([A-Z]+\d+):\s+(.*)$/;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const m = paren.exec(line) ?? colon.exec(line);
    if (m === null) continue;
    diags.push({
      file: normPath(m[1] as string),
      line: Number(m[2]),
      column: Number(m[3]),
      severity: normSeverity(m[4] as string),
      code: m[5] as string,
      message: (m[6] as string).trim(),
      source: "tsc",
    });
  }
  return diags;
}

/**
 * pyright --outputjson output: a JSON object with `generalDiagnostics: [{file, severity,
 * message, rule?, range:{start:{line,character}}}]`. Pyright positions are 0-based.
 */
export function parsePyright(output: string): LspDiagnostic[] {
  const json = extractJsonObject(output);
  if (json === undefined) return [];
  const general = (json as { generalDiagnostics?: unknown }).generalDiagnostics;
  if (!Array.isArray(general)) return [];
  const diags: LspDiagnostic[] = [];
  for (const d of general) {
    if (typeof d !== "object" || d === null) continue;
    const rec = d as Record<string, unknown>;
    const file = typeof rec.file === "string" ? rec.file : "";
    const message = typeof rec.message === "string" ? rec.message.replace(/\s*\n\s*/g, " ").trim() : "";
    if (file.length === 0 || message.length === 0) continue;
    const start = (rec.range as { start?: { line?: unknown; character?: unknown } } | undefined)?.start;
    const zeroLine = typeof start?.line === "number" ? start.line : -1;
    const zeroChar = typeof start?.character === "number" ? start.character : -1;
    diags.push({
      file: normPath(file),
      line: zeroLine >= 0 ? zeroLine + 1 : 0,
      column: zeroChar >= 0 ? zeroChar + 1 : 0,
      severity: normSeverity(typeof rec.severity === "string" ? rec.severity : "error"),
      message,
      source: "pyright",
      ...(typeof rec.rule === "string" ? { code: rec.rule } : {}),
    });
  }
  return diags;
}

/**
 * `go vet ./...` output (on stderr): lines like
 *   ./main.go:10:2: undefined: foo
 *   path/to/file.go:7:1: message
 * Diagnostic lines have at least `file:line:col: msg` or `file:line: msg`.
 */
export function parseGoVet(output: string): LspDiagnostic[] {
  const diags: LspDiagnostic[] = [];
  const withCol = /^(.+\.go):(\d+):(\d+):\s+(.*)$/;
  const noCol = /^(.+\.go):(\d+):\s+(.*)$/;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Skip go's framing lines ("# package", "vet: ...", "go: ...").
    if (line.startsWith("#") || line.startsWith("vet:") || line.startsWith("go:")) continue;
    let m = withCol.exec(line);
    if (m !== null) {
      diags.push({ file: normPath(m[1] as string), line: Number(m[2]), column: Number(m[3]), severity: "error", message: (m[4] as string).trim(), source: "go vet" });
      continue;
    }
    m = noCol.exec(line);
    if (m !== null) {
      diags.push({ file: normPath(m[1] as string), line: Number(m[2]), column: 0, severity: "error", message: (m[3] as string).trim(), source: "go vet" });
    }
  }
  return diags;
}

/**
 * `cargo check --message-format=json` output: newline-delimited JSON objects. Compiler
 * diagnostics have `{reason:"compiler-message", message:{level, message, code:{code}, spans:[
 * {file_name, line_start, column_start, is_primary}]}}`. We take the primary span (or first).
 */
export function parseCargo(output: string): LspDiagnostic[] {
  const diags: LspDiagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line[0] !== "{") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.reason !== "compiler-message") continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    if (msg === undefined || typeof msg.message !== "string") continue;
    const level = typeof msg.level === "string" ? msg.level : "error";
    // cargo emits a final "aborting due to N errors" summary with no span — skip it.
    if (level !== "error" && level !== "warning") continue;
    const spans = Array.isArray(msg.spans) ? (msg.spans as Array<Record<string, unknown>>) : [];
    const primary = spans.find((s) => s.is_primary === true) ?? spans[0];
    if (primary === undefined) continue;
    const code = (msg.code as { code?: unknown } | null | undefined)?.code;
    diags.push({
      file: normPath(typeof primary.file_name === "string" ? primary.file_name : ""),
      line: typeof primary.line_start === "number" ? primary.line_start : 0,
      column: typeof primary.column_start === "number" ? primary.column_start : 0,
      severity: normSeverity(level),
      message: (msg.message as string).replace(/\s*\n\s*/g, " ").trim(),
      source: "cargo",
      ...(typeof code === "string" ? { code } : {}),
    });
  }
  return diags;
}

/** Map a tool's severity word to ikbi's three-level scale. */
function normSeverity(raw: string): "error" | "warning" | "info" {
  const s = raw.toLowerCase();
  if (s === "error") return "error";
  if (s === "warning" || s === "warn") return "warning";
  return "info";
}

/** Extract the first top-level JSON object from mixed output (pyright may print a banner first). */
function extractJsonObject(output: string): unknown {
  const start = output.indexOf("{");
  if (start < 0) return undefined;
  // Scan for the matching closing brace (string-aware) so a trailing log line can't break parse.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < output.length; i += 1) {
    const ch = output[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(output.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
