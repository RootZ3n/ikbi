/**
 * ikbi agent tool — lsp_diagnostic.
 *
 * The single biggest capability a cheap model lacks vs. an editor: the language server's view of
 * the code. This tool hands it exactly that — typed, structured diagnostics — so it can SEE its
 * errors before claiming `done`, instead of guessing. It drives each detected language's compiler
 * diagnostic engine through governed-exec (see ../lsp). The builder is steered to run this before
 * `done`; the chat exposes it as an inspection tool.
 *
 * TRUST: the returned string is derived from compiler output — UNTRUSTED. The caller re-neutralizes
 * it at its own chokepoint (same as terminal / run_checks) before it re-enters the model.
 */

import type { OperationContext } from "../../core/identity/index.js";
import type { ModelTool } from "../../core/provider/contract.js";
import type { GovernedExec } from "../governed-exec/index.js";
import { formatLspReport, runLspDiagnostics, type LspLanguage } from "../lsp/index.js";

/** The tool declared to the model. */
export const lspDiagnosticTool: ModelTool = {
  name: "lsp_diagnostic",
  description:
    "Run language-server-grade diagnostics on the project and get structured errors/warnings (file, line, column, severity, message) — the same signal an editor's red squiggles give you. " +
    "Auto-detects the project type (TypeScript via tsc, Python via pyright, Go via go vet, Rust via cargo check). " +
    "Use this BEFORE claiming done to catch type errors and undefined references the tests might miss. Read-only. " +
    'Optionally pass a single `language` to restrict the check. Example: {} or {"language": "typescript"}',
  parameters: {
    type: "object",
    properties: {
      language: {
        type: "string",
        enum: ["typescript", "python", "go", "rust"],
        description: "Restrict diagnostics to one language. Omit to run every detected language.",
      },
    },
    required: [],
  },
};

const VALID_LANGUAGES: ReadonlySet<string> = new Set(["typescript", "python", "go", "rust"]);

/** What the tool needs at call time: the governed executor + the run's identity + the worktree. */
export interface LspToolDeps {
  readonly governedExec: Pick<GovernedExec, "run">;
  readonly parentCtx?: OperationContext;
  /** The resolved worktree the diagnostics run against. */
  readonly worktreeReal: string;
}

/**
 * Run lsp_diagnostic and return a model-readable result string. Never throws past the boundary;
 * an unexpected failure becomes an `ERROR:` string (like every other tool).
 */
export async function runLspDiagnostic(deps: LspToolDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) {
    return "ERROR: lsp_diagnostic is unavailable (no parent identity wired to authorize the governed diagnostic commands).";
  }
  const rawLang = typeof args.language === "string" ? args.language.toLowerCase() : undefined;
  if (rawLang !== undefined && !VALID_LANGUAGES.has(rawLang)) {
    return `ERROR: unknown language "${rawLang}" — use one of typescript, python, go, rust (or omit to check all detected languages).`;
  }
  try {
    const report = await runLspDiagnostics(
      { governedExec: deps.governedExec, parentCtx: deps.parentCtx },
      { rootDir: deps.worktreeReal, ...(rawLang !== undefined ? { language: rawLang as LspLanguage } : {}) },
    );
    return formatLspReport(report);
  } catch (e) {
    return `ERROR: lsp_diagnostic failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
