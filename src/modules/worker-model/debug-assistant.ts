/**
 * ikbi worker-model — DEBUG ASSISTANT.
 *
 * Parses raw verifier error output (TypeScript, test failures, runtime errors,
 * build errors) into structured ParsedError entries, then builds a rich debug
 * report that gives the builder actionable context: file paths, line numbers,
 * error codes, human-readable fix directions, and optional surrounding code.
 *
 * PURE: no IO, no spawn, no clock. Never throws — degrades to a safe fallback.
 *
 * Integration: the iterative loop's `formatFixGoal` calls `formatDebugFixGoal`
 * to replace the raw "Fix these errors:" dump with a structured debug report.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/** The category of a parsed error. */
export type ErrorCategory = "typescript" | "test" | "runtime" | "build" | "unknown";

/** A single structured error extracted from raw output. */
export interface ParsedError {
  /** Error category (determines which parser matched). */
  readonly category: ErrorCategory;
  /** Source file path, if extractable. */
  readonly file?: string | undefined;
  /** 1-based line number, if extractable. */
  readonly line?: number | undefined;
  /** 1-based column number, if extractable. */
  readonly column?: number | undefined;
  /** TypeScript error code (e.g. "TS2322"), if applicable. */
  readonly code?: string | undefined;
  /** Human-readable error message (always non-empty). */
  readonly message: string;
  /** The original raw line(s) that produced this error. */
  readonly raw: string;
  /** Suggested fix direction for the builder. */
  readonly suggestedFix: string;
}

/** Options for building the debug report. */
export interface DebugReportOptions {
  /**
   * Optional file reader for including surrounding code context.
   * Given a file path (as extracted from the error), returns its contents.
   * Absent ⇒ no surrounding code is included.
   */
  readonly readFile?: (path: string) => string | undefined;
  /** Number of context lines above/below the error line (default: 5). */
  readonly contextLines?: number;
}

// ── Error Parsers ──────────────────────────────────────────────────────────────

/**
 * Parse TypeScript diagnostic errors.
 * Matches formats:
 *   - `src/foo.ts(10,5): error TS2322: message`   (classic tsc)
 *   - `src/foo.ts:10:5 - error TS2322: message`   (newer tsc)
 *   - `src/foo.ts:10 - error TS2322: message`      (no column)
 */
function parseTypeScriptErrors(line: string): ParsedError | undefined {
  // Classic format: path(line,col): error TSxxxx: msg
  const classic = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/.exec(line);
  if (classic) {
    return {
      category: "typescript",
      file: classic[1],
      line: Number(classic[2]),
      column: Number(classic[3]),
      code: classic[4],
      message: classic[5]!,
      raw: line,
      suggestedFix: suggestTypeScriptFix(classic[4]!, classic[5]!),
    };
  }

  // Newer format with column: path:line:col - error TSxxxx: msg
  const newerCol = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s*(.+)$/.exec(line);
  if (newerCol) {
    return {
      category: "typescript",
      file: newerCol[1],
      line: Number(newerCol[2]),
      column: Number(newerCol[3]),
      code: newerCol[4],
      message: newerCol[5]!,
      raw: line,
      suggestedFix: suggestTypeScriptFix(newerCol[4]!, newerCol[5]!),
    };
  }

  // Newer format without column: path:line - error TSxxxx: msg
  const newerNoCol = /^(.+?):(\d+)\s+-\s+error\s+(TS\d+):\s*(.+)$/.exec(line);
  if (newerNoCol) {
    return {
      category: "typescript",
      file: newerNoCol[1],
      line: Number(newerNoCol[2]),
      code: newerNoCol[3],
      message: newerNoCol[4]!,
      raw: line,
      suggestedFix: suggestTypeScriptFix(newerNoCol[3]!, newerNoCol[4]!),
    };
  }

  return undefined;
}

/**
 * Parse test failure lines from common frameworks.
 * Matches:
 *   - TAP: `not ok 42 - test name`
 *   - Vitest/Jest FAIL: `FAIL src/foo.test.ts`
 *   - AssertionError: `AssertionError: expected X to equal Y`
 *   - Vitest/Jest: `AssertionError: expected X to be Y`
 *   - Generic: `Error: ...` inside test context
 */
function parseTestErrors(line: string): ParsedError | undefined {
  // TAP: not ok N - test name
  const tap = /^not ok \d+\s*-?\s*(.*)$/.exec(line);
  if (tap) {
    return {
      category: "test",
      message: tap[1]!.trim().length > 0 ? `Test failed: ${tap[1]!.trim()}` : "Test failed (no description)",
      raw: line,
      suggestedFix: "Review the failing test assertion. Check expected vs actual values and fix the code to match the test's expectations.",
    };
  }

  // Vitest/Jest FAIL line with file
  const vitestFail = /^FAIL\s+(\S+\.test\.\S+)\s*$/.exec(line);
  if (vitestFail) {
    return {
      category: "test",
      file: vitestFail[1],
      message: `Test file failed: ${vitestFail[1]}`,
      raw: line,
      suggestedFix: "A test file has failures. Read the test output below for specific assertion errors and fix the code under test.",
    };
  }

  // AssertionError (common across frameworks)
  const assertFail = /^AssertionError:\s*(.+)$/.exec(line);
  if (assertFail) {
    return {
      category: "test",
      message: assertFail[1]!,
      raw: line,
      suggestedFix: "An assertion failed. Compare expected vs actual values and fix the implementation to produce the correct result.",
    };
  }

  // Generic test error: `Error: something` — only match if it looks test-related
  // (too broad otherwise; we handle these as runtime errors instead)

  return undefined;
}

/**
 * Parse runtime errors with stack traces.
 * Matches:
 *   - `Error: message`
 *   - `TypeError: message`
 *   - `ReferenceError: message`
 *   - `SyntaxError: message`
 *   - Stack trace lines: `    at Function (file.ts:10:5)`
 */
function parseRuntimeErrors(line: string): ParsedError | undefined {
  // Standard error types — broad match: any WordError: ... pattern
  const errMatch = /^(\w*Error):\s*(.+)$/.exec(line);
  if (errMatch) {
    return {
      category: "runtime",
      message: `${errMatch[1]}: ${errMatch[2]}`,
      raw: line,
      suggestedFix: suggestRuntimeFix(errMatch[1]!, errMatch[2]!),
    };
  }

  return undefined;
}

/**
 * Parse build/compilation errors (non-TypeScript).
 * Matches:
 *   - `error: Cannot find module 'xyz'`
 *   - `Module not found: ...`
 *   - `SyntaxError: Unexpected token ...`
 *   - `ENOENT: no such file or directory`
 */
function parseBuildErrors(line: string): ParsedError | undefined {
  // Cannot find module
  const modNotFound = /Cannot find module\s+'([^']+)'/i.exec(line);
  if (modNotFound) {
    return {
      category: "build",
      message: `Cannot find module '${modNotFound[1]}'`,
      raw: line,
      suggestedFix: `The module '${modNotFound[1]}' is missing. Check the import path, verify the package is installed (npm/pnpm install), or ensure the file exists.`,
    };
  }

  // Module not found (webpack-style)
  const webpackMod = /Module not found:\s*(.+)/i.exec(line);
  if (webpackMod) {
    return {
      category: "build",
      message: webpackMod[1]!.trim(),
      raw: line,
      suggestedFix: "A module could not be resolved. Check the import path and ensure the dependency is installed.",
    };
  }

  // ENOENT
  const enoent = /ENOENT.*(?:open|access)\s+'([^']+)'/i.exec(line);
  if (enoent) {
    return {
      category: "build",
      message: `File not found: ${enoent[1]}`,
      raw: line,
      suggestedFix: `The file '${enoent[1]}' does not exist. Check the path and ensure it was created.`,
    };
  }

  return undefined;
}

// ── Fix Suggestions ────────────────────────────────────────────────────────────

/** Map common TS error codes to actionable fix directions. */
function suggestTypeScriptFix(code: string, message: string): string {
  switch (code) {
    case "TS2322":
      return "Type mismatch: the assigned value does not match the expected type. Check the type annotation and the expression being assigned.";
    case "TS2339":
      return "Property does not exist on type: verify the property name is correct and the object has the expected type.";
    case "TS2307":
      return "Cannot find module: check the import path, verify the module exists, and ensure it is installed.";
    case "TS2345":
      return "Argument type mismatch: the argument passed does not match the function's parameter type. Check the function signature.";
    case "TS2304":
      return "Cannot find name: the identifier is not in scope. Check for typos, missing imports, or missing declarations.";
    case "TS2554":
      return "Wrong number of arguments: the function call has too many or too few arguments. Check the function signature.";
    case "TS2353":
      return "Object literal has unknown properties: remove the extra properties or update the type definition.";
    case "TS7006":
      return "Implicit any: the parameter has no type annotation. Add an explicit type or enable noImplicitAny.";
    case "TS7053":
      return "Element has an implicit any type: add an index signature to the type or add explicit type annotations.";
    case "TS2532":
      return "Object is possibly undefined: add a null check or use optional chaining before accessing the property.";
    case "TS18048":
      return "Value is possibly undefined: add a null check or use the non-null assertion operator.";
    case "TS2367":
      return "Type comparison error: the two types have no overlap. Check the comparison logic.";
    case "TS2769":
      return "No overload matches this call: check the function overload signatures and ensure the arguments match one.";
    default:
      if (/not assignable to/i.test(message)) return "Type mismatch: ensure the value's type matches what is expected. Check type annotations and casts.";
      if (/does not exist/i.test(message)) return "A property or name does not exist: verify the spelling and the type/interface definition.";
      if (/cannot find/i.test(message)) return "A name or module was not found: check imports and ensure the dependency exists.";
      return `TypeScript error ${code}: review the error message and fix the type issue at the indicated location.`;
  }
}

/** Map runtime error types to actionable fix directions. */
function suggestRuntimeFix(errorType: string, message: string): string {
  switch (errorType) {
    case "TypeError":
      if (/cannot read prop/i.test(message) || /is not a function/i.test(message)) {
        return "The value is null/undefined or not the expected type at runtime. Add null checks or verify the initialization order.";
      }
      return "A value has the wrong type at runtime. Check variable initialization, function return types, and null/undefined handling.";
    case "ReferenceError":
      return "A variable or function is not in scope. Check for typos, missing imports, or variable scope issues.";
    case "SyntaxError":
      return "Invalid syntax in the source code. Fix the syntax at the indicated location (missing brackets, commas, keywords).";
    case "RangeError":
      return "A value is out of range (e.g. negative array index, infinite recursion). Check loop bounds and recursion limits.";
    case "URIError":
      return "An invalid URI was passed to a URI function. Check the URL/URI encoding.";
    default:
      return `Runtime error (${errorType}): review the stack trace and fix the code at the indicated location.`;
  }
}

// ── Core Parser ────────────────────────────────────────────────────────────────

/**
 * Parse raw error output into structured ParsedError entries.
 * Never throws — any unparseable lines become `unknown` errors.
 */
export function parseErrors(rawErrors: string): ParsedError[] {
  if (!rawErrors || rawErrors.trim().length === 0) return [];

  const errors: ParsedError[] = [];
  const lines = rawErrors.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;

    // Skip check-name prefixes from extractVerifierCheckResult: `[typecheck] ...`, `[test] ...`
    const stripped = line.replace(/^\[(\w+)\]\s*/, "");
    const checkPrefix = /^\[(\w+)\]/.exec(line)?.[1];

    // Try each parser in priority order
    let parsed: ParsedError | undefined;

    // TypeScript errors are most specific — try first
    parsed = parseTypeScriptErrors(stripped);
    if (parsed) { errors.push(parsed); continue; }

    // Runtime errors (Error: ..., TypeError: ...) — before test to catch assertion errors
    parsed = parseRuntimeErrors(stripped);
    if (parsed) {
      // If it came from a test check, reclassify as test error
      if (checkPrefix === "test" || /assert/i.test(parsed.message)) {
        errors.push({
          ...parsed,
          category: "test",
          suggestedFix: "An assertion failed in a test. Compare expected vs actual values and fix the implementation.",
        });
      } else {
        errors.push(parsed);
      }
      continue;
    }

    // Test failures (TAP, vitest FAIL, AssertionError)
    parsed = parseTestErrors(stripped);
    if (parsed) { errors.push(parsed); continue; }

    // Build errors (missing modules, ENOENT)
    parsed = parseBuildErrors(stripped);
    if (parsed) { errors.push(parsed); continue; }

    // Unknown — wrap as-is
    if (stripped.length > 0) {
      errors.push({
        category: "unknown",
        message: stripped,
        raw: line,
        suggestedFix: "Review this error in context and fix the indicated issue.",
      });
    }
  }

  return errors;
}

// ── Debug Report Builder ───────────────────────────────────────────────────────

/**
 * Build a surrounding-code snippet (N lines above/below the error line).
 * Returns undefined if the file cannot be read or line is missing.
 */
function extractSurroundingCode(
  readFile: (path: string) => string | undefined,
  filePath: string,
  errorLine: number,
  contextLines: number,
): string | undefined {
  try {
    const content = readFile(filePath);
    if (content === undefined) return undefined;
    const allLines = content.split("\n");
    const start = Math.max(0, errorLine - 1 - contextLines);
    const end = Math.min(allLines.length, errorLine + contextLines);
    const snippet = allLines
      .slice(start, end)
      .map((l, idx) => {
        const lineNum = start + idx + 1;
        const marker = lineNum === errorLine ? " > " : "   ";
        return `${marker}${lineNum}| ${l}`;
      })
      .join("\n");
    return snippet;
  } catch {
    return undefined;
  }
}

/** Format a single ParsedError into a human-readable entry for the debug report. */
function formatErrorEntry(
  err: ParsedError,
  index: number,
  options: DebugReportOptions,
): string {
  const parts: string[] = [];

  // Header
  const header = `Error ${index + 1} [${err.category.toUpperCase()}]`;
  const location = err.file !== undefined
    ? ` at ${err.file}${err.line !== undefined ? `:${err.line}` : ""}${err.column !== undefined ? `:${err.column}` : ""}`
    : "";
  parts.push(`${header}${location}`);

  // Error code
  if (err.code !== undefined) {
    parts.push(`  Code: ${err.code}`);
  }

  // Message
  parts.push(`  Message: ${err.message}`);

  // Suggested fix
  parts.push(`  Suggested fix: ${err.suggestedFix}`);

  // Surrounding code
  if (err.file !== undefined && err.line !== undefined && options.readFile !== undefined) {
    const ctxLines = options.contextLines ?? 5;
    const code = extractSurroundingCode(options.readFile, err.file, err.line, ctxLines);
    if (code !== undefined) {
      parts.push(`  Context:\n${code.split("\n").map((l) => `    ${l}`).join("\n")}`);
    }
  }

  return parts.join("\n");
}

/**
 * Build a structured debug report from parsed errors.
 * The report includes file paths, line numbers, error codes, messages,
 * suggested fix directions, and optional surrounding code context.
 */
export function buildDebugReport(errors: ParsedError[], options: DebugReportOptions = {}): string {
  if (errors.length === 0) return "No errors to report.";

  const parts: string[] = [];
  parts.push(`Found ${errors.length} error(s):\n`);

  for (let i = 0; i < errors.length; i++) {
    parts.push(formatErrorEntry(errors[i]!, i, options));
    parts.push(""); // blank line between entries
  }

  // Summary by category
  const byCategory = new Map<ErrorCategory, number>();
  for (const err of errors) {
    byCategory.set(err.category, (byCategory.get(err.category) ?? 0) + 1);
  }
  const summary = [...byCategory.entries()]
    .map(([cat, count]) => `${count} ${cat}`)
    .join(", ");
  parts.push(`Summary: ${summary}`);

  return parts.join("\n");
}

/**
 * High-level function: parse raw verifier errors and produce a structured
 * debug fix goal for the builder. Replaces the old raw "Fix these errors:" dump.
 */
export function formatDebugFixGoal(rawErrors: string, options: DebugReportOptions = {}): string {
  const errors = parseErrors(rawErrors);
  const report = buildDebugReport(errors, options);
  return `The verifier found errors in your code. Fix them:\n\n${report}`;
}
