/**
 * ikbi LSP module — shared contract.
 *
 * `lsp_diagnostic` gives a cheap model the SAME signal a human gets from their editor's
 * red squiggles: language-server-grade diagnostics, BEFORE it claims `done`. Rather than
 * embed a long-lived JSON-RPC language-server client (heavy, stateful, fragile under the
 * governed-exec leash), ikbi drives each language's canonical compiler-diagnostic command
 * — the same engine the language server itself wraps — through governed-exec and parses
 * the structured output into a uniform `LspDiagnostic[]`.
 *
 *   TypeScript  →  tsc --noEmit            (the exact engine tsserver uses)
 *   Python      →  pyright --outputjson    (the engine pylance/pyright-langserver wraps)
 *   Go          →  go vet ./...            (gopls surfaces vet diagnostics)
 *   Rust        →  cargo check (JSON)       (the engine rust-analyzer drives for checks)
 *
 * Every diagnostic is normalized to {file, line, column, severity, message, source, code}.
 */

/** A single diagnostic, language-agnostic. Line/column are 1-based (editor convention). */
export interface LspDiagnostic {
  /** Worktree-relative file path (forward slashes). */
  readonly file: string;
  /** 1-based line number (0 when the tool reported no position). */
  readonly line: number;
  /** 1-based column number (0 when the tool reported no position). */
  readonly column: number;
  /** Severity, normalized across tools. */
  readonly severity: "error" | "warning" | "info";
  /** Human-readable message (single line; the parser collapses continuations). */
  readonly message: string;
  /** Which diagnostic engine produced this (e.g. "tsc", "pyright", "go vet", "cargo"). */
  readonly source: string;
  /** Tool-specific diagnostic code when available (e.g. "TS2322", "reportUndefinedVariable"). */
  readonly code?: string;
}

/** The languages ikbi can run diagnostics for. */
export type LspLanguage = "typescript" | "python" | "go" | "rust";

/** A detected language and the marker that revealed it. */
export interface DetectedLanguage {
  readonly language: LspLanguage;
  /** The config file / extension that triggered detection (for the operator-readable report). */
  readonly marker: string;
}

/** The outcome of running diagnostics for ONE language. */
export interface LspRunResult {
  readonly language: LspLanguage;
  /** The diagnostic engine command line that ran (for the report). */
  readonly command: string;
  /** Did the diagnostic command actually run? false ⇒ denied/missing/unavailable (see `note`). */
  readonly ran: boolean;
  /** The normalized diagnostics (empty ⇒ clean, when `ran`). */
  readonly diagnostics: readonly LspDiagnostic[];
  /** A short note when the run could not produce diagnostics (binary denied, tool missing, etc.). */
  readonly note?: string;
}

/** The full `lsp_diagnostic` result across every detected (or requested) language. */
export interface LspDiagnosticReport {
  /** The languages that were detected in the project. */
  readonly detected: readonly DetectedLanguage[];
  /** Per-language run results. */
  readonly results: readonly LspRunResult[];
}
